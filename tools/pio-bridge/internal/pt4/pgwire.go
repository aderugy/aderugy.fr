package pt4

// A minimal PostgreSQL client: enough to run read-only queries against the
// local PokerTracker 4 database without a third-party driver.
//
// Protocol v3, simple query protocol, text results. Authentication: trust,
// cleartext, MD5 and SCRAM-SHA-256 (PostgreSQL 16's default). No TLS: the
// database is on the same machine.

import (
	"bufio"
	"crypto/hmac"
	"crypto/md5"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DSN is a parsed postgres://user:password@host:port/dbname URL.
type DSN struct {
	User, Password, Host, Port, Database string
}

func ParseDSN(s string) (DSN, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return DSN{}, fmt.Errorf("connection URL: %w", err)
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return DSN{}, errors.New("connection URL must start with postgres://")
	}
	d := DSN{Host: u.Hostname(), Port: u.Port(), Database: strings.TrimPrefix(u.Path, "/")}
	if u.User != nil {
		d.User = u.User.Username()
		d.Password, _ = u.User.Password()
	}
	if d.Host == "" {
		d.Host = "localhost"
	}
	if d.Port == "" {
		d.Port = "5432"
	}
	if d.User == "" || d.Database == "" {
		return DSN{}, errors.New("connection URL needs a user and a database name")
	}
	return d, nil
}

// Redacted is the DSN without its password, for logs and the status page.
func (d DSN) Redacted() string {
	return fmt.Sprintf("postgres://%s@%s:%s/%s", d.User, d.Host, d.Port, url.PathEscape(d.Database))
}

// PGError is an error reported by the server.
type PGError struct {
	Severity, Code, Message string
}

func (e *PGError) Error() string {
	return fmt.Sprintf("postgres %s %s: %s", e.Severity, e.Code, e.Message)
}

// Conn is one connection. Not safe for concurrent use.
type Conn struct {
	c   net.Conn
	r   *bufio.Reader
	buf []byte
}

// Rows is a query result: column names and text values (nil = NULL).
type Rows struct {
	Columns []string
	Values  [][][]byte
}

func Connect(d DSN, timeout time.Duration) (*Conn, error) {
	nc, err := net.DialTimeout("tcp", net.JoinHostPort(d.Host, d.Port), timeout)
	if err != nil {
		return nil, err
	}
	cn := &Conn{c: nc, r: bufio.NewReaderSize(nc, 64<<10)}
	_ = nc.SetDeadline(time.Now().Add(timeout))
	if err := cn.startup(d); err != nil {
		nc.Close()
		return nil, err
	}
	_ = nc.SetDeadline(time.Time{})
	return cn, nil
}

func (cn *Conn) Close() error {
	_ = cn.send('X', nil)
	return cn.c.Close()
}

/* -------------------------------------------------------------- framing */

func (cn *Conn) send(typ byte, body []byte) error {
	msg := make([]byte, 0, 5+len(body))
	if typ != 0 {
		msg = append(msg, typ)
	}
	msg = binary.BigEndian.AppendUint32(msg, uint32(4+len(body)))
	msg = append(msg, body...)
	_, err := cn.c.Write(msg)
	return err
}

func (cn *Conn) recv() (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(cn.r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := int(binary.BigEndian.Uint32(hdr[1:])) - 4
	if n < 0 || n > 1<<30 {
		return 0, nil, fmt.Errorf("bad message length %d", n)
	}
	if cap(cn.buf) < n {
		cn.buf = make([]byte, n)
	}
	b := cn.buf[:n]
	if _, err := io.ReadFull(cn.r, b); err != nil {
		return 0, nil, err
	}
	return hdr[0], b, nil
}

func cstr(s string) []byte { return append([]byte(s), 0) }

func parseError(b []byte) *PGError {
	e := &PGError{}
	for len(b) > 1 {
		f := b[0]
		i := 1
		for i < len(b) && b[i] != 0 {
			i++
		}
		v := string(b[1:i])
		switch f {
		case 'S':
			e.Severity = v
		case 'C':
			e.Code = v
		case 'M':
			e.Message = v
		}
		b = b[min(i+1, len(b)):]
	}
	return e
}

/* --------------------------------------------------------------- startup */

func (cn *Conn) startup(d DSN) error {
	var body []byte
	body = binary.BigEndian.AppendUint32(body, 196608) // protocol 3.0
	for _, kv := range [][2]string{
		{"user", d.User}, {"database", d.Database},
		{"application_name", "PioBridge"}, {"client_encoding", "UTF8"},
		// Belt and braces: the role is read-only too.
		{"default_transaction_read_only", "on"},
	} {
		body = append(body, cstr(kv[0])...)
		body = append(body, cstr(kv[1])...)
	}
	body = append(body, 0)
	if err := cn.send(0, body); err != nil {
		return err
	}
	var scram *scramClient
	for {
		t, b, err := cn.recv()
		if err != nil {
			return err
		}
		switch t {
		case 'E':
			return parseError(b)
		case 'R':
			if len(b) < 4 {
				return errors.New("bad auth message")
			}
			code := binary.BigEndian.Uint32(b)
			switch code {
			case 0: // AuthenticationOk
			case 3: // cleartext
				if err := cn.send('p', cstr(d.Password)); err != nil {
					return err
				}
			case 5: // MD5
				salt := b[4:8]
				h1 := md5.Sum([]byte(d.Password + d.User))
				h2 := md5.Sum(append([]byte(hex.EncodeToString(h1[:])), salt...))
				if err := cn.send('p', cstr("md5"+hex.EncodeToString(h2[:]))); err != nil {
					return err
				}
			case 10: // SASL
				if !strings.Contains(string(b[4:]), "SCRAM-SHA-256\x00") {
					return errors.New("server wants an unsupported SASL mechanism")
				}
				scram = newScram(d.Password)
				first := scram.clientFirst()
				msg := cstr("SCRAM-SHA-256")
				msg = binary.BigEndian.AppendUint32(msg, uint32(len(first)))
				msg = append(msg, first...)
				if err := cn.send('p', msg); err != nil {
					return err
				}
			case 11: // SASLContinue
				if scram == nil {
					return errors.New("unexpected SASL continue")
				}
				final, err := scram.clientFinal(string(b[4:]))
				if err != nil {
					return err
				}
				if err := cn.send('p', []byte(final)); err != nil {
					return err
				}
			case 12: // SASLFinal
				if scram == nil || !scram.verifyServer(string(b[4:])) {
					return errors.New("server signature mismatch (SCRAM)")
				}
			default:
				return fmt.Errorf("unsupported authentication method %d", code)
			}
		case 'Z':
			return nil
		case 'S', 'K', 'N': // parameter status, backend key, notice
		default:
			return fmt.Errorf("unexpected message %q during startup", t)
		}
	}
}

/* ----------------------------------------------------------------- query */

// Query runs one statement with the simple query protocol. Build SQL with
// Literal / integers only.
func (cn *Conn) Query(sql string, timeout time.Duration) (*Rows, error) {
	_ = cn.c.SetDeadline(time.Now().Add(timeout))
	defer cn.c.SetDeadline(time.Time{})
	if err := cn.send('Q', cstr(sql)); err != nil {
		return nil, err
	}
	res := &Rows{}
	var qerr error
	for {
		t, b, err := cn.recv()
		if err != nil {
			return nil, err
		}
		switch t {
		case 'T':
			n := int(binary.BigEndian.Uint16(b))
			b = b[2:]
			res.Columns = make([]string, 0, n)
			for i := 0; i < n; i++ {
				j := 0
				for b[j] != 0 {
					j++
				}
				res.Columns = append(res.Columns, string(b[:j]))
				b = b[j+1+18:]
			}
		case 'D':
			n := int(binary.BigEndian.Uint16(b))
			b = b[2:]
			row := make([][]byte, n)
			// One allocation per row for all its values.
			data := make([]byte, 0, len(b))
			for i := 0; i < n; i++ {
				l := int32(binary.BigEndian.Uint32(b))
				b = b[4:]
				if l < 0 {
					continue
				}
				start := len(data)
				data = append(data, b[:l]...)
				row[i] = data[start : start+int(l) : start+int(l)]
				b = b[l:]
			}
			res.Values = append(res.Values, row)
		case 'E':
			qerr = parseError(b)
		case 'Z':
			return res, qerr
		case 'C', 'I', 'N', 'S':
		default:
			return nil, fmt.Errorf("unexpected message %q", t)
		}
	}
}

// Literal quotes a string for SQL (standard_conforming_strings is on since
// PostgreSQL 9.1: only quotes need doubling).
func Literal(s string) string {
	s = strings.ReplaceAll(s, "\x00", "")
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

/* ------------------------------------------------------------------ SCRAM */

type scramClient struct {
	password, nonce, firstBare string
	saltedPassword             []byte
	authMessage                string
}

func newScram(password string) *scramClient {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return &scramClient{password: password, nonce: base64.RawStdEncoding.EncodeToString(b)}
}

func (s *scramClient) clientFirst() string {
	s.firstBare = "n=,r=" + s.nonce
	return "n,," + s.firstBare
}

func (s *scramClient) clientFinal(serverFirst string) (string, error) {
	var nonce, salt string
	iter := 0
	for _, kv := range strings.Split(serverFirst, ",") {
		if len(kv) < 2 || kv[1] != '=' {
			continue
		}
		switch kv[0] {
		case 'r':
			nonce = kv[2:]
		case 's':
			salt = kv[2:]
		case 'i':
			iter, _ = strconv.Atoi(kv[2:])
		}
	}
	if !strings.HasPrefix(nonce, s.nonce) || iter <= 0 {
		return "", errors.New("bad SCRAM server message")
	}
	saltB, err := base64.StdEncoding.DecodeString(salt)
	if err != nil {
		return "", err
	}
	s.saltedPassword, err = pbkdf2.Key(sha256.New, s.password, saltB, iter, 32)
	if err != nil {
		return "", err
	}
	finalBare := "c=biws,r=" + nonce
	s.authMessage = s.firstBare + "," + serverFirst + "," + finalBare
	clientKey := hmacSum(s.saltedPassword, "Client Key")
	stored := sha256.Sum256(clientKey)
	sig := hmacSum(stored[:], s.authMessage)
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ sig[i]
	}
	return finalBare + ",p=" + base64.StdEncoding.EncodeToString(proof), nil
}

func (s *scramClient) verifyServer(serverFinal string) bool {
	v, ok := strings.CutPrefix(strings.TrimSpace(serverFinal), "v=")
	if !ok {
		return false
	}
	serverKey := hmacSum(s.saltedPassword, "Server Key")
	want := base64.StdEncoding.EncodeToString(hmacSum(serverKey, s.authMessage))
	return hmac.Equal([]byte(v), []byte(want))
}

func hmacSum(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}
