package pt4

// PokerTracker 4 player notes: table `notes`, enum_type 'P', id_x = id_player,
// one row per player. The text is wxWidgets rich text (XML):
//
//	<richtext version="1.0.0.0" xmlns="http://www.wxwidgets.org">
//	  <paragraphlayout …>
//	    <paragraph><text>line</text></paragraph>
//	  </paragraphlayout>
//	</richtext>
//
// The site edits plain text: one paragraph per line. Saving keeps the
// original <paragraphlayout> (font, margins) but drops inline formatting (a
// bold run…); Rich tells the page a note has some.
//
// Writes need, on top of the read-only grants:
//
//	GRANT INSERT, UPDATE ON public.notes TO aderugy_ro;
//
// The role stays read-only by default: only SaveNote opens a READ WRITE
// transaction, and it only touches `notes`.

import (
	"encoding/xml"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Note struct {
	Player int64  `json:"player"`
	ID     int64  `json:"id"`
	Color  int    `json:"color"`
	Date   string `json:"date"` // PT4's date_note, "2026-10-27T19:28:19"; the version for conflicts
	Text   string `json:"text"`
	// Rich: the note has formatting the site can't keep (bold, colours…).
	Rich bool `json:"rich"`
}

const MaxNoteColor = 15

var ErrNoteChanged = errors.New("the note changed in PokerTracker since it was loaded")

// NoteConflict carries the current note when a save hits ErrNoteChanged.
type NoteConflict struct{ Current *Note }

func (NoteConflict) Error() string { return ErrNoteChanged.Error() }
func (NoteConflict) Unwrap() error { return ErrNoteChanged }

const noteCols = `id_note, id_x, coalesce(id_color, 0), to_char(date_note, 'YYYY-MM-DD"T"HH24:MI:SS'), note`

func parseNoteRow(v [][]byte) Note {
	text, rich := NoteText(string(v[4]))
	return Note{ID: atoi(v[0]), Player: atoi(v[1]), Color: int(atoi(v[2])), Date: string(v[3]), Text: text, Rich: rich}
}

// Notes returns the player notes of the given players (latest note when
// there are several).
func (s *Service) Notes(ids []int64) (map[int64]Note, error) {
	out := map[int64]Note{}
	if len(ids) == 0 {
		return out, nil
	}
	r, err := s.query("SELECT " + noteCols + " FROM notes WHERE enum_type = 'P' AND id_x IN (" + idList(ids) + ") ORDER BY id_note")
	if err != nil {
		return nil, err
	}
	for _, v := range r.Values {
		n := parseNoteRow(v)
		out[n.Player] = n
	}
	return out, nil
}

// SaveNote writes a player's note. expected is the Date of the note the
// edit started from ("" = there was none): if PT4 changed it meanwhile, the
// save is refused with a NoteConflict holding the current note.
func (s *Service) SaveNote(player int64, color int, text, expected string) (*Note, error) {
	if color < 0 || color > MaxNoteColor {
		return nil, fmt.Errorf("colour %d out of range", color)
	}
	if len(text) > 32<<10 {
		return nil, errors.New("note too long")
	}
	pid := strconv.FormatInt(player, 10)
	var saved *Note
	err := s.withConn(func(c *Conn) error {
		q := func(sql string) (*Rows, error) { return c.Query(sql, 10*time.Second) }
		if _, err := q("BEGIN READ WRITE"); err != nil {
			return err
		}
		ok := false
		defer func() {
			if !ok {
				_, _ = q("ROLLBACK")
			}
		}()
		// Serialises with other writers (PT4 included) while we pick an id.
		if _, err := q("LOCK TABLE notes IN EXCLUSIVE MODE"); err != nil {
			return err
		}
		r, err := q("SELECT " + noteCols + " FROM notes WHERE enum_type = 'P' AND id_x = " + pid + " ORDER BY id_note DESC LIMIT 1")
		if err != nil {
			return err
		}
		var cur *Note
		var raw string
		if len(r.Values) > 0 {
			n := parseNoteRow(r.Values[0])
			cur, raw = &n, string(r.Values[0][4])
		}
		if (cur == nil && expected != "") || (cur != nil && cur.Date != expected) {
			return NoteConflict{Current: cur}
		}
		if cur == nil {
			// The player must exist, and notes take his game type.
			pr, err := q("SELECT 1 FROM player WHERE id_player = " + pid)
			if err != nil {
				return err
			}
			if len(pr.Values) == 0 {
				return fmt.Errorf("no player %d in the PT4 database", player)
			}
			_, err = q(`INSERT INTO notes (id_note, id_x, enum_type, flg_tournament, id_gametype, date_note, id_color, note, note_tsvector)
SELECT coalesce(max(id_note), 0) + 1, ` + pid + `, 'P', false, 0, localtimestamp(0), ` + strconv.Itoa(color) + `, ` +
				Literal(NoteXML(text, "")) + `, ''::tsvector FROM notes`)
			if err != nil {
				return err
			}
		} else {
			_, err = q("UPDATE notes SET note = " + Literal(NoteXML(text, raw)) + ", id_color = " + strconv.Itoa(color) +
				", date_note = greatest(localtimestamp(0), date_note + interval '1 second') WHERE id_note = " + strconv.FormatInt(cur.ID, 10))
			if err != nil {
				return err
			}
		}
		r, err = q("SELECT " + noteCols + " FROM notes WHERE enum_type = 'P' AND id_x = " + pid + " ORDER BY id_note DESC LIMIT 1")
		if err != nil {
			return err
		}
		if _, err := q("COMMIT"); err != nil {
			return err
		}
		ok = true
		n := parseNoteRow(r.Values[0])
		saved = &n
		return nil
	})
	return saved, err
}

func idList(ids []int64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	return strings.Join(parts, ",")
}

/* -------------------------------------------------------------- rich text */

// NoteText extracts the plain text of a wxWidgets rich text note: one line
// per paragraph. rich: it has formatting a plain-text save would drop.
func NoteText(raw string) (text string, rich bool) {
	if !strings.Contains(raw, "<richtext") {
		return raw, false // not XML: plain text as is
	}
	d := xml.NewDecoder(strings.NewReader(raw))
	d.Strict = false
	var lines []string
	var cur strings.Builder
	inPara, inText, runs := false, false, 0
	for {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "paragraph":
				inPara, runs = true, 0
				cur.Reset()
			case "text":
				inText = true
				runs++
				if len(t.Attr) > 0 || runs > 1 {
					rich = true
				}
			case "richtext", "paragraphlayout":
			default:
				if inPara {
					rich = true // image, field, symbol…
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "paragraph":
				lines = append(lines, cur.String())
				inPara = false
			case "text":
				inText = false
			}
		case xml.CharData:
			if inText {
				cur.Write(t)
			}
		}
	}
	// wxWidgets keeps a final empty paragraph; drop trailing blank lines.
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n"), rich
}

var layoutTag = regexp.MustCompile(`<paragraphlayout[^>]*>`)

const defaultLayout = `<paragraphlayout margin-left="4,4098" margin-right="4,4098" margin-top="4,4098" margin-bottom="4,4098">`

// NoteXML writes text as PT4 rich text, keeping the <paragraphlayout> (font,
// margins) of the previous version when there is one.
func NoteXML(text, previous string) string {
	layout := layoutTag.FindString(previous)
	if layout == "" {
		layout = defaultLayout
	}
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<richtext version=\"1.0.0.0\" xmlns=\"http://www.wxwidgets.org\">\n  ")
	b.WriteString(layout)
	b.WriteString("\n")
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	for _, line := range strings.Split(text, "\n") {
		b.WriteString("    <paragraph>\n      <text>")
		b.WriteString(xmlEscape(line))
		b.WriteString("</text>\n    </paragraph>\n")
	}
	b.WriteString("  </paragraphlayout>\n</richtext>\n")
	return b.String()
}

func xmlEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\t':
			b.WriteRune(r)
		default:
			if r < 0x20 || r == 0xFFFE || r == 0xFFFF {
				continue // not allowed in XML
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}

/* ------------------------------------------------------------- auto-notes */

// AutoNote is one of PT4's auto-generated notes (table notes_auto): one per
// player and definition, regenerated by PT4. Read-only here.
type AutoNote struct {
	// Category: PT4's id_category; 1 preflop, 2 flop, 3 turn, 4 river as far
	// as the data shows.
	Category int    `json:"category"`
	Text     string `json:"text"` // e.g. "3Bet range {cardrange:QQ-KK,AQs+,AKo}"
	Count    int    `json:"count"`
	Hands    int    `json:"hands"` // number of hand ids PT4 lists for it
	Updated  string `json:"updated"`
}

// AutoNotes returns the auto-notes of the given players, by category then
// most frequent first.
func (s *Service) AutoNotes(ids []int64) (map[int64][]AutoNote, error) {
	out := map[int64][]AutoNote{}
	if len(ids) == 0 {
		return out, nil
	}
	r, err := s.query(`SELECT id_player, coalesce(id_category, 0), note, coalesce(cnt_times, 0),
  length(id_hands) - length(replace(id_hands, ';', '')), to_char(date_updated, 'YYYY-MM-DD"T"HH24:MI:SS')
FROM notes_auto WHERE id_player IN (` + idList(ids) + `)
ORDER BY id_player, id_category, cnt_times DESC, note`)
	if err != nil {
		return nil, err
	}
	for _, v := range r.Values {
		id := atoi(v[0])
		out[id] = append(out[id], AutoNote{Category: int(atoi(v[1])), Text: string(v[2]), Count: int(atoi(v[3])),
			Hands: int(atoi(v[4])), Updated: string(v[5])})
	}
	return out, nil
}
