-- Four hands of "Villain" (id 1) at a 6-max table, for the PT4 integration
-- test. Load on top of an empty PT4 schema (pg_dump -s of a real database):
--   psql -d "PT4 DB" -f pt4_fixture.sql
-- PT4 positions: 0 BTN, 1 CO, 2 MP, 3 EP, 9 SB, 8 BB.

INSERT INTO lookup_sites (id_site, site_abbrev, site_name) VALUES (1, 'WIN', 'Winamax');
INSERT INTO cash_limit (id_limit, limit_name, id_gametype, limit_currency, amt_sb, amt_bb, id_filter)
VALUES (1, 'NL200', 1, 'EUR', 1, 2, 0), (2, 'NL100', 1, 'EUR', 0.5, 1, 0);
INSERT INTO player (id_player, id_site, player_name, player_name_search)
VALUES (1, 1, 'Villain', 'villain'), (2, 1, 'Hero', 'hero'), (3, 1, 'Vil_lain%', 'vil_lain%');
INSERT INTO lookup_positions (cnt_players, position, absolute_position, description, flg_sb, flg_bb, flg_ep, flg_mp, flg_co, flg_btn)
VALUES (6, 3, 3, 'EP', false, false, true, false, false, false),
       (6, 2, 4, 'MP', false, false, false, true, false, false),
       (6, 1, 5, 'CO', false, false, false, false, true, false),
       (6, 0, 6, 'BTN', false, false, false, false, false, true),
       (6, 9, 1, 'SB', true, false, false, false, false, false),
       (6, 8, 2, 'BB', false, true, false, false, false, false);
INSERT INTO lookup_actions (id_action, action) VALUES
  (0, ''), (1, 'F'), (2, 'C'), (3, 'R'), (4, 'X'), (5, 'RF'), (6, 'RC'), (7, 'B'),
  (8, 'XF'), (9, 'XC'), (10, 'BF'), (11, 'XR'), (12, 'CF'), (13, 'CC'), (14, 'RR');

INSERT INTO cash_hand_summary (id_hand, id_gametype, id_site, id_limit, id_table, hand_no, date_played, date_imported,
  cnt_players, cnt_players_lookup_position, cnt_players_f, button, str_aggressors_p, str_actors_p,
  str_aggressors_f, str_actors_f, str_aggressors_t, str_actors_t, str_aggressors_r, str_actors_r)
VALUES
  (101, 1, 1, 1, 1, 'h101', '2026-11-01 20:00', now(), 6, 6, 0, 0, '808', '08', '', '', '', '', '', ''),
  (102, 1, 1, 1, 1, 'h102', '2026-11-01 20:01', now(), 6, 6, 2, 0, '81', '10', '1', '10', '0', '10', '', ''),
  (103, 1, 1, 1, 1, 'h103', '2026-11-01 20:02', now(), 6, 6, 0, 0, '8', '', '', '', '', '', '', ''),
  (104, 1, 1, 2, 2, 'h104', '2026-11-10 20:00', now(), 6, 6, 2, 0, '88', '98', '8', '98', '', '', '', '');

-- H101 BTN opens, BB 3bets, Villain folds.            won -2.5 (-1.25 bb)
-- H102 CO opens, BTN calls, cbet called, check-fold turn. won -14 (-7 bb)
-- H103 BB walk.                                         won +1 (+0.5 bb)
-- H104 (NL100) SB limps, BB raises, call; check-fold flop vs cbet. won -3 (-3 bb)
INSERT INTO cash_hand_player_statistics (id_hand, id_gametype, id_player, id_player_real, id_holecard, id_limit, id_session,
  date_played, id_final_hand, id_final_hand_lo, holecard_1, holecard_2, holecard_3, holecard_4, id_suits,
  position, cnt_players, cnt_players_lookup_position, id_action_p, id_action_f, id_action_t, id_action_r,
  flg_vpip, flg_p_open_opp, flg_p_first_raise, cnt_p_raise, cnt_p_call, flg_p_limp, flg_p_fold, flg_p_face_raise,
  flg_steal_opp, flg_steal_att, flg_p_3bet_def_opp, enum_p_3bet_action, flg_p_4bet_opp,
  flg_f_saw, flg_f_open_opp, flg_f_bet, flg_f_cbet_opp, flg_f_cbet, flg_f_check, flg_f_fold, flg_f_cbet_def_opp, enum_f_cbet_action,
  flg_t_saw, flg_t_open_opp, flg_t_cbet_opp, flg_t_check, flg_t_fold, amt_t_bet_facing, amt_f_bet_facing,
  amt_won, amt_bet_ttl)
VALUES
  (101, 1, 1, 1, 0, 1, 1, '2026-11-01 20:00', 0, 0, 0, 0, 0, 0, 0, 0, 6, 6, 5, 0, 0, 0,
   true, true, true, 1, 0, false, true, false, true, true, true, 'F', true,
   false, false, false, false, false, false, false, false, null,
   false, false, false, false, false, 0, 0, -2.5, 2.5),
  (102, 1, 1, 1, 0, 1, 1, '2026-11-01 20:01', 0, 0, 0, 0, 0, 0, 0, 1, 6, 6, 3, 7, 8, 0,
   true, true, true, 1, 0, false, false, false, false, false, false, null, false,
   true, true, true, true, true, false, false, false, null,
   true, true, true, true, true, 12, 0, -14, 14),
  (103, 1, 1, 1, 0, 1, 1, '2026-11-01 20:02', 0, 0, 0, 0, 0, 0, 0, 8, 6, 6, 0, 0, 0, 0,
   false, false, false, 0, 0, false, false, false, false, false, false, null, false,
   false, false, false, false, false, false, false, false, null,
   false, false, false, false, false, 0, 0, 1, 0),
  (104, 1, 1, 1, 0, 2, 2, '2026-11-10 20:00', 0, 0, 0, 0, 0, 0, 0, 9, 6, 6, 13, 8, 0, 0,
   true, true, false, 0, 2, true, false, true, false, false, false, null, false,
   true, false, false, false, false, true, true, true, 'F',
   false, false, false, false, false, 0, 2, -3, 3);

-- PT4's own counters for Villain (one week row).
INSERT INTO cash_cache (id_player, id_gametype, id_limit, cnt_players, position_type, flg_has_position_f, flg_has_position_t,
  flg_has_position_r, date_played_year_week, cnt_hands, cnt_walks, cnt_vpip, cnt_pfr, cnt_pfr_opp, cnt_f_cbet, cnt_f_cbet_opp)
VALUES (1, 1, 1, 6, 0, false, false, false, 202645, 4, 1, 3, 2, 3, 1, 1);

-- Notes: Villain has one (PT4's own XML, as exported), plus a hand note to ignore.
INSERT INTO notes (id_note, id_x, enum_type, flg_tournament, id_gametype, date_note, id_color, note, note_tsvector) VALUES
(1327, 1, 'P', false, 0, '2026-10-27 19:28:19', 6, '<?xml version="1.0" encoding="UTF-8"?>
<richtext version="1.0.0.0" xmlns="http://www.wxwidgets.org">
  <paragraphlayout textcolor="#000000" fontpointsize="9" fontfamily="70" fontstyle="90" fontweight="400" fontunderlined="0" fontface="Segoe UI" alignment="1" parspacingafter="10" parspacingbefore="0" linespacing="10" margin-left="5,4098" margin-right="5,4098" margin-top="5,4098" margin-bottom="5,4098">
    <paragraph>
      <text>C4B = QQ</text>
    </paragraph>
    <paragraph>
      <text></text>
    </paragraph>
    <paragraph>
      <text>4BP &lt;= ccbet ip = C33 2ndPf s. Kxxss, C66 br T, X/X FoB R =&gt; MV bluff</text>
    </paragraph>
  </paragraphlayout>
</richtext>
', ''),
(1330, 101, 'H', false, 0, '2026-11-11 21:23:12', 0, '<?xml version="1.0" encoding="UTF-8"?><richtext/>', '');

-- Auto-notes (PT4 generates them): two for Villain, one for Hero.
INSERT INTO notes_auto (id_autonote, id_player, uuid_name, id_category, flg_tournament, id_gametype, note, cnt_times, id_hands, date_added, date_updated) VALUES
(1, 1, '92cc9e95-28df-8ed4-ada2-9bc149bd7985', 1, false, 0, '3Bet range {cardrange:QQ-KK,AQs+,AKo}', 9, '101;102;104;', '2026-11-01', '2026-11-19'),
(2, 1, '4c4ee887-9d98-8449-c471-2852247869e9', 2, false, 0, 'Raised Flop Cbet w/Overpair or less & no draw', 2, '102;', '2026-11-01', '2026-11-19'),
(3, 1, 'fbfd6831-397b-1975-a655-4889effb63e4', 1, false, 0, 'Called 2Bet from blinds range {cardrange:55,A5s,K2s,A9o-ATo,KJo}', 11, '104;', '2026-11-01', '2026-11-18'),
(4, 2, 'fbfd6831-397b-1975-a655-4889effb63e4', 1, false, 0, 'Called 2Bet from blinds range {cardrange:97s,A8o,QJo}', 3, '103;', '2026-11-01', '2026-11-19');
