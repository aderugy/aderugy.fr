package pt4

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Service keeps a few connections to the PT4 database and, for each player
// asked about, all his hands in memory: a HUD for any filter is then computed
// in a few milliseconds, and only new hands are fetched afterwards.
type Service struct {
	Logf func(format string, args ...any)

	mu      sync.Mutex
	dsn     DSN
	dsnErr  error
	pool    chan *Conn
	open    int
	lastErr error
	lastOK  time.Time

	positions Positions
	catalogue []*Stat

	maxHand   int64
	maxAt     time.Time
	maxMu     sync.Mutex
	limitsAt  time.Time
	limits    []Limit
	limitsMu  sync.Mutex
	players   map[int64]*playerCache
	playersMu sync.Mutex
}

type playerCache struct {
	mu       sync.Mutex
	id       int64
	name     string
	site     string
	hands    []Hand
	upTo     int64 // highest id_hand loaded
	loaded   bool
	lastUsed time.Time
	results  map[string]cachedResult
}

type cachedResult struct {
	upTo   int64
	count  int
	values Values
}

const (
	poolSize     = 3
	queryTimeout = 60 * time.Second
	maxCached    = 200 // players kept in memory
	maxEvery     = 2 * time.Second
)

var ErrNotConfigured = errors.New("PokerTracker 4 database not configured")

func NewService(dsn string) *Service {
	s := &Service{Logf: func(string, ...any) {}, players: map[int64]*playerCache{}, catalogue: SortedCatalogue()}
	s.Configure(dsn)
	return s
}

// Configure (re)sets the connection URL; open connections are dropped.
func (s *Service) Configure(dsn string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pool != nil {
		close(s.pool)
		for c := range s.pool {
			c.Close()
		}
	}
	s.pool = make(chan *Conn, poolSize)
	s.open = 0
	s.positions = nil
	s.lastErr = nil
	if strings.TrimSpace(dsn) == "" {
		s.dsn, s.dsnErr = DSN{}, ErrNotConfigured
	} else {
		s.dsn, s.dsnErr = ParseDSN(dsn)
	}
	s.playersMu.Lock()
	s.players = map[int64]*playerCache{}
	s.playersMu.Unlock()
}

/* ------------------------------------------------------------ connections */

func (s *Service) acquire() (*Conn, chan *Conn, error) {
	s.mu.Lock()
	if s.dsnErr != nil {
		s.mu.Unlock()
		return nil, nil, s.dsnErr
	}
	pool, dsn := s.pool, s.dsn
	select {
	case c := <-pool:
		s.mu.Unlock()
		return c, pool, nil
	default:
	}
	if s.open < poolSize {
		s.open++
		s.mu.Unlock()
		c, err := Connect(dsn, 5*time.Second)
		if err != nil {
			s.mu.Lock()
			s.open--
			s.lastErr = err
			s.mu.Unlock()
			return nil, nil, fmt.Errorf("cannot connect to the PT4 database (%s): %w", dsn.Redacted(), err)
		}
		return c, pool, nil
	}
	s.mu.Unlock()
	select {
	case c, ok := <-pool:
		if !ok {
			return nil, nil, errors.New("connection settings changed, retry")
		}
		return c, pool, nil
	case <-time.After(queryTimeout):
		return nil, nil, errors.New("PT4 database busy")
	}
}

func (s *Service) release(c *Conn, pool chan *Conn, broken bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pool != s.pool { // settings changed meanwhile: the old pool is gone
		c.Close()
		return
	}
	if broken {
		c.Close()
		s.open--
		return
	}
	s.pool <- c // never blocks: at most poolSize connections exist
}

// query runs SQL on a pooled connection. Server errors keep the connection;
// network errors drop it.
func (s *Service) query(sql string) (*Rows, error) {
	c, pool, err := s.acquire()
	if err != nil {
		return nil, err
	}
	r, err := c.Query(sql, queryTimeout)
	var pe *PGError
	broken := err != nil && !errors.As(err, &pe)
	s.release(c, pool, broken)
	s.mu.Lock()
	if err != nil {
		s.lastErr = err
	} else {
		s.lastErr = nil
		s.lastOK = time.Now()
	}
	s.mu.Unlock()
	return r, err
}

func (s *Service) ensurePositions() (Positions, error) {
	s.mu.Lock()
	p := s.positions
	s.mu.Unlock()
	if p != nil {
		return p, nil
	}
	r, err := s.query(PositionsQuery)
	if err != nil {
		return nil, err
	}
	p = ParsePositions(r)
	s.mu.Lock()
	s.positions = p
	s.mu.Unlock()
	return p, nil
}

/* ----------------------------------------------------------------- status */

type Status struct {
	Configured bool   `json:"configured"`
	Connected  bool   `json:"connected"`
	Database   string `json:"database,omitempty"`
	Error      string `json:"error,omitempty"`
	MaxHand    int64  `json:"maxHand"`
	Cached     int    `json:"cachedPlayers"`
}

// Status pings the database (cheap: max hand id, cached 2 s).
func (s *Service) Status() Status {
	s.mu.Lock()
	st := Status{Configured: s.dsnErr == nil}
	if s.dsnErr == nil {
		st.Database = s.dsn.Redacted()
	} else if !errors.Is(s.dsnErr, ErrNotConfigured) {
		st.Error = s.dsnErr.Error()
	}
	s.mu.Unlock()
	if st.Configured {
		m, err := s.MaxHand()
		st.MaxHand = m
		st.Connected = err == nil
		if err != nil {
			st.Error = err.Error()
		}
	}
	s.playersMu.Lock()
	st.Cached = len(s.players)
	s.playersMu.Unlock()
	return st
}

// MaxHand is the highest id_hand in the database (cached maxEvery).
func (s *Service) MaxHand() (int64, error) {
	s.maxMu.Lock()
	defer s.maxMu.Unlock()
	if time.Since(s.maxAt) < maxEvery {
		return s.maxHand, nil
	}
	r, err := s.query("SELECT coalesce(max(id_hand), 0) FROM cash_hand_summary")
	if err != nil {
		return s.maxHand, err
	}
	s.maxHand = atoi(r.Values[0][0])
	s.maxAt = time.Now()
	return s.maxHand, nil
}

/* ---------------------------------------------------------------- players */

type Player struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Site  string `json:"site"`
	Hands int64  `json:"hands"`
}

// likeEscape escapes LIKE wildcards (backslash is the default escape).
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// Search finds cash players whose name contains q (prefix matches first).
func (s *Service) Search(q string, limit int) ([]Player, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []Player{}, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	e := likeEscape(q)
	sql := `WITH m AS (
  SELECT id_player, player_name, id_site FROM player
  WHERE player_name ILIKE ` + Literal("%"+e+"%") + ` LIMIT 500
)
SELECT m.id_player, m.player_name, coalesce(ls.site_abbrev, ''), coalesce(sum(c.cnt_hands), 0) AS hands
FROM m
LEFT JOIN cash_cache c ON c.id_player = m.id_player
LEFT JOIN lookup_sites ls ON ls.id_site = m.id_site
GROUP BY 1, 2, 3
HAVING coalesce(sum(c.cnt_hands), 0) > 0
ORDER BY (m.player_name ILIKE ` + Literal(e+"%") + `) DESC, hands DESC, m.player_name
LIMIT ` + strconv.Itoa(limit)
	r, err := s.query(sql)
	if err != nil {
		return nil, err
	}
	out := make([]Player, 0, len(r.Values))
	for _, v := range r.Values {
		out = append(out, Player{ID: atoi(v[0]), Name: string(v[1]), Site: string(v[2]), Hands: int64(atof(v[3]))})
	}
	return out, nil
}

type Limit struct {
	ID       int16   `json:"id"`
	Name     string  `json:"name"`
	BB       float64 `json:"bb"`
	Currency string  `json:"currency"`
	Hands    int64   `json:"hands"`
}

// Limits lists the stakes with hands (cached one minute).
func (s *Service) Limits() ([]Limit, error) {
	s.limitsMu.Lock()
	defer s.limitsMu.Unlock()
	if s.limits != nil && time.Since(s.limitsAt) < time.Minute {
		return s.limits, nil
	}
	r, err := s.query(`SELECT l.id_limit, l.limit_name, coalesce(l.amt_bb, 0), l.limit_currency, h.n
FROM (SELECT id_limit, count(*) AS n FROM cash_hand_summary GROUP BY id_limit) h
JOIN cash_limit l ON l.id_limit = h.id_limit
ORDER BY l.amt_bb, l.limit_name`)
	if err != nil {
		return nil, err
	}
	out := make([]Limit, 0, len(r.Values))
	for _, v := range r.Values {
		out = append(out, Limit{ID: int16(atoi(v[0])), Name: string(v[1]), BB: atof(v[2]),
			Currency: strings.TrimSpace(string(v[3])), Hands: atoi(v[4])})
	}
	s.limits, s.limitsAt = out, time.Now()
	return out, nil
}

/* -------------------------------------------------------------------- HUD */

type HUD struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Site   string `json:"site"`
	Hands  int    `json:"hands"` // hands matching the filter
	Total  int    `json:"total"` // all hands of the player
	Stats  Values `json:"stats"`
	Error  string `json:"error,omitempty"`
	Millis int64  `json:"ms"`
}

func (s *Service) player(id int64) *playerCache {
	s.playersMu.Lock()
	defer s.playersMu.Unlock()
	pc := s.players[id]
	if pc == nil {
		pc = &playerCache{id: id, results: map[string]cachedResult{}}
		s.players[id] = pc
		if len(s.players) > maxCached {
			s.evictLocked()
		}
	}
	pc.lastUsed = time.Now()
	return pc
}

func (s *Service) evictLocked() {
	type e struct {
		id int64
		t  time.Time
	}
	var all []e
	for id, pc := range s.players {
		all = append(all, e{id, pc.lastUsed})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
	for _, x := range all[:len(all)-maxCached] {
		delete(s.players, x.id)
	}
}

// refresh loads the player's hands the first time, then only new ones.
func (pc *playerCache) refresh(s *Service, maxHand int64) error {
	if pc.loaded && pc.upTo >= maxHand {
		return nil
	}
	pos, err := s.ensurePositions()
	if err != nil {
		return err
	}
	if !pc.loaded {
		r, err := s.query(`SELECT p.player_name, coalesce(ls.site_abbrev, '') FROM player p
LEFT JOIN lookup_sites ls ON ls.id_site = p.id_site WHERE p.id_player = ` + strconv.FormatInt(pc.id, 10))
		if err != nil {
			return err
		}
		if len(r.Values) == 0 {
			return fmt.Errorf("no player %d in the PT4 database", pc.id)
		}
		pc.name, pc.site = string(r.Values[0][0]), string(r.Values[0][1])
	}
	t0 := time.Now()
	r, err := s.query(HandsQuery(pc.id, pc.upTo))
	if err != nil {
		return err
	}
	hands, err := ParseHands(r, pos)
	if err != nil {
		return err
	}
	if len(hands) > 0 {
		merged := append(pc.hands, hands...)
		// New hands are usually the latest, but an import of old files isn't.
		if len(pc.hands) > 0 && hands[0].Date < pc.hands[len(pc.hands)-1].Date {
			sort.SliceStable(merged, func(i, j int) bool {
				if merged[i].Date != merged[j].Date {
					return merged[i].Date < merged[j].Date
				}
				return merged[i].ID < merged[j].ID
			})
		}
		pc.hands = merged
		for _, h := range hands {
			pc.upTo = max(pc.upTo, h.ID)
		}
		if pc.loaded || len(hands) > 1000 {
			s.Logf("pt4: %s +%d hands in %d ms", pc.name, len(hands), time.Since(t0).Milliseconds())
		}
	}
	pc.upTo = max(pc.upTo, maxHand)
	pc.loaded = true
	return nil
}

// HUDs computes the HUD of each player for the filter. Players are loaded in
// parallel (up to the pool size).
func (s *Service) HUDs(ids []int64, f Filter) ([]HUD, int64, error) {
	maxHand, err := s.MaxHand()
	if err != nil {
		return nil, 0, err
	}
	out := make([]HUD, len(ids))
	sem := make(chan struct{}, poolSize)
	var wg sync.WaitGroup
	key := f.Key()
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			t0 := time.Now()
			pc := s.player(id)
			pc.mu.Lock()
			defer pc.mu.Unlock()
			hud := HUD{ID: id}
			if err := pc.refresh(s, maxHand); err != nil {
				hud.Error = err.Error()
				out[i] = hud
				return
			}
			hud.Name, hud.Site, hud.Total = pc.name, pc.site, len(pc.hands)
			res, ok := pc.results[key]
			if !ok || res.upTo != pc.upTo {
				sel := Select(pc.hands, f)
				res = cachedResult{upTo: pc.upTo, count: len(sel), values: Compute(s.catalogue, sel)}
				if len(pc.results) > 16 {
					pc.results = map[string]cachedResult{}
				}
				pc.results[key] = res
			}
			hud.Hands, hud.Stats = res.count, res.values
			hud.Millis = time.Since(t0).Milliseconds()
			out[i] = hud
		}(i, id)
	}
	wg.Wait()
	return out, maxHand, nil
}

// StatNames lists the catalogue with each stat's kind.
func (s *Service) StatNames() map[string]Kind {
	m := map[string]Kind{}
	for _, st := range s.catalogue {
		m[st.Name] = st.Kind
	}
	return m
}
