# SWGB matchmaking server

The matchmaking, lobby and ladder server for the game client of the Star Wars: Galactic Battlegrounds remaster, in the
style of Golden Age's built-in matchmaking: accounts, Elo ratings and profiles, ranked and unranked queues (1v1, team,
FFA) with a map pool by category and per-map toggles, a weekly queue, an open-game lobby browser with a minimum /
maximum rating per room and lobby chat, friends, parties, direct messages, match history with replays, and connection
brokering for the game itself.

It is a fork of the server side of [Empire League](https://github.com/ForgeableSum/empire-league) by ForgeableSum
(MIT licence), used with its author's permission.

## Features

- **Accounts and ratings**: local accounts (a name and a scrypt-hashed password), separate Elo pools for solo, team
  and FFA, divisions, a leaderboard per pool, profiles with recent matches.
- **Queues**: ranked and unranked 1v1, team and FFA queues, widening rating ranges, a balanced team split, a map pool
  by group with per-map toggles and favourites, a weekly rotating queue, accept / decline with a cooldown.
- **Lobbies**: open games with a rating window, chat, ready marks, civilisations, teams and host settings; optional
  passwords, search and filters, the host's kick, slot, team and computer-player controls.
- **Social**: friends with presence, direct messages (kept for offline players), parties that queue together.
- **Brokering**: a direct connection, then a UDP hole punch, then a TCP relay, whichever comes up first.
- **Results**: reports from every player, corroboration, contested results, FFA placings, stored replays.
- **Moderation**: roles (player, moderator, admin), timed or permanent bans by account and optionally by address,
  timed mutes of chat and direct messages, player reports, an audit log of every moderator action; over the protocol
  for a logged-in moderator and from the server's shell (`src/admin.mjs`).
- **Admin dashboard**: an HTTP page of its own (off by default, 127.0.0.1): online players, queues, live matches
  and lobbies, recent results, the reports queue with ban / mute / dismiss, bans and mutes, the audit log, a broadcast.
- **Public pages**: an optional read-only listener (off by default) with leaderboards, profiles, match results,
  tournaments, as minimal HTML and as JSON.
- **Discord**: optional webhook posts when someone waits in the ranked 1v1 queue and when a ranked 1v1 result is in.
- **Tournaments**: single-elimination 1v1 brackets made by staff, with a registration window, an optional password and
  rating cap, seeding by rating, server-made matches per round, walkovers and tournament chat.
- **Seasons** (off by default): calendar quarters; each season's ratings are kept and then soft-reset.
- **Hosting**: TLS on the control link with certificate reload, abuse limits, replay retention, JSON-line logs, a
  health check, online backups, a container image.

## Credit and licence

This server is a fork of the server side of **Empire League** by **ForgeableSum**
(<https://github.com/ForgeableSum/empire-league>, commit `32353bc`, MIT licence), used with its author's permission.
Taken from it: the queue and match flow (tickets, match found, accept / decline with a cooldown, match start), the
widening rating ranges, the balanced team split, the map pool by group with favourites, the weekly FFA grouping, the
custom lobbies, the Elo rule (K = 32, team averages), separate rating pools, divisions, and the result reports with
corroboration. Left out, as Age of Empires II: DE specific: Steam sign-in, the AoE2 lobby automation, replay parsing,
civilisation rolls, tournaments, Discord, Twitch and the Electron client. MySQL is replaced by a local SQLite file
(`node:sqlite`). The Empire League name and logos are not used.

This repository is MIT licensed ([`LICENSE`](LICENSE)). Empire League's licence notice is kept in
[`LICENSE.empire-league`](LICENSE.empire-league); files adapted from it say so at the top.

## Requirements

- Node.js 22.13 or later.
- No npm dependencies: there is nothing to `npm install`.

## Running locally

```
node src/server.mjs                       # 127.0.0.1:4317, data/matchmaking.db
node src/server.mjs --port 4400 --db build/mm.db --min-queue-ms 0 --test-maps
node src/cli.mjs profile NAME             # look at a running server: profile, leaderboard [solo|team|ffa], rooms, maps
```

Options: `--config FILE`, `--host` (default 127.0.0.1), `--port` (TCP and the same number on UDP), `--db`,
`--min-queue-ms` (15000), `--ffa-players` (4), `--accept-ms` (30000), `--corroboration-ms` (60000), `--test-maps`
(adds a "Test" map group for automated runs), `--tls-cert FILE --tls-key FILE`, `--no-health`, `--health-host`,
`--health-port`.

**It binds to 127.0.0.1 by default.** Opening it to other machines (`--host 0.0.0.0`, firewall rules, a public
address) is up to you; see [`HOSTING.md`](HOSTING.md).

In the game client: the main menu's **Online** button. The client has a built-in default server; the **Server** field
on the log-in screen or `--mm-server HOST:PORT` points it at another one.

## Configuration

Every option can be set in a JSON config file (`--config FILE` or the `SWGB_MM_CONFIG` environment variable); the
command line wins. [`config.example.json`](config.example.json) lists every option and is the container's built-in
config; defaults are in `src/config.mjs`. A config file may give any subset: objects merge key by key with the
defaults, and an unknown key is an error.

- **TLS on the control link** (`tls.enabled`, `tls.cert` / `tls.key`): a connection that starts with a TLS handshake is
  wrapped; any other may only open a relay (the game's own frames; a log-in over plain TCP is refused). The certificate
  files are checked every `tls.reloadSeconds` and a changed pair is used by new connections (no restart after a
  renewal; a pair that does not load keeps the old one). The game client checks the certificate against the Windows
  roots (or `--mm-ca FILE`) and the host name; it speaks plain TCP only to the local computer (`localhost`, `127.x`).
- **Abuse limits** (`limits`, `accounts`, `messages`): connections in all and per address, the message size, a log-in
  deadline, messages per second per connection, log-in attempts per minute and new accounts per hour per address, a
  lock-out of an account name after failed log-ins, a chat rate per player (lobby, party, direct messages), datagrams
  per second per address, relay tokens waiting; name rules (length, characters, reserved names), password length, an
  account cap.
- **Replays**: a size cap (`replays.maxBytes`) and retention (`replays.retentionDays`, swept every
  `replays.sweepMinutes`, with the expired sessions).
- **Logs**: JSON lines on stdout (`log.level`); never a password or a token.
- **Health check**: `GET /health` on `health.host:health.port` (127.0.0.1:4318), the status as JSON, 503 when the
  database, the listener or the certificate is not fine.
- **Backups**: `node src/backup.mjs [DB] OUT` makes a consistent copy while the server runs.

## Tests

```
npm test
```

The tests run over real sockets on 127.0.0.1 only. TLS tests use a certificate made at test time by
`test/selfsigned.mjs` (no key is committed). `test/tls_echo.mjs` is a small TLS line server for testing a client's TLS
code.

## Container image

`ghcr.io/swgbremastered/matchmaking`, built and published by GitHub Actions
([`.github/workflows/image.yml`](.github/workflows/image.yml)) on every push to `main` after the tests and a
start-and-health-check smoke test. Tags are `<package.json version>-<8-char commit>` (for example `0.2.0-1a2b3c4d`),
plus a moving `main` tag. Deploy an exact tag, never `main` or `latest`. `scripts/publish-image.sh` builds (and with
`--push` publishes) the same image by hand. See [`HOSTING.md`](HOSTING.md) for running it.

## How a ranked game comes about

1. The game client logs in (`register` / `login`: a name and a password, scrypt-hashed in the local database) and gets
   its profile (a rating per pool: solo, team, FFA; peak, wins, losses, streak, division, rank; recent matches).
2. `queue_join` with the queue (`1v1`, `team` with team sizes, `ffa`) and the map pool (enabled groups, the maps
   toggled on, favourites). The service matches tickets whose ratings are within each other's range (1v1: 50, widening
   to 250 over 90 s; team 100 to 500; FFA twice the team range), who share a map; closest rating first.
3. `match_found` to every player; each answers `accept` or `decline` within 30 s. When all accept: `match_start` with
   the map, the seed, the players and slots (the first to queue hosts, slot 1).
4. Brokering: the host listens and sends `host_addr`; each guest gets `connect` and tries a **direct** TCP connection;
   failing that, `punch_request`: both register a UDP socket with the rendezvous (`{"t":"reg","token","slot"}` to the
   service's UDP port), learn each other's address and **punch**; failing that, `relay_request`: both open a TCP
   connection to the service whose first line is `{"t":"relay","token","slot"}`, and the service **relays** the bytes.
   The game itself runs its own multiplayer lockstep protocol over the link.
5. Each peer reports `result`: `winners` (slots) at its game's end, or `resigned` when it leaves. Agreeing reports from
   every player still connected settle the match (else the first report after the corroboration time); conflicting
   reports make it contested (no rating change). The service answers `result_recorded` with every rating change.

Open games: `rooms`, `room_create` (name, minElo, maxElo, maxPlayers, map, pool, ranked), `room_join` (refused outside
the room's rating window), `room_chat`, `room_ready`, `room_leave`, `room_start` (the host, when everyone is ready).

## More features

- **Unranked queues** beside the ranked ones: `queue_join` with `ranked: false` (1v1 / team / FFA): the same matching
  and map pool in a lane of their own, paired by a hidden casual rating per format (pools `casual_solo`, `casual_team`,
  `casual_ffa`: never on a profile or a leaderboard); the result changes no shown rating and is kept in the history.
- **Weekly queue**: `queue_join` with `queue: "weekly"`: this ISO week's format and map pool (`src/weekly.mjs`,
  rotation index = weeks since 2026-01-05), unranked, the week kept with the match. `weekly` (and `maps`) say which.
- **Friends**: `friend_add` / `friend_accept` / `friend_remove` (`name`), `friends` -> `friends {friends: [{name, state:
  friend|incoming|outgoing, presence}]}`, `friend_request {from}`.
- **Presence** (`offline`, `idle`, `looking`, `in_lobby`, `in_game`): pushed to friends and party members as
  `presence {name, presence}` whenever it changes; `presence {name}` asks.
- **Direct messages**: `dm {to, text}` (a friend or a party member) -> `dm {from, to, text, at}` both ways; kept for an
  offline player and delivered at log-in (`offline: true`); `dm_history {with}`.
- **Parties**: `party_invite {name}` (the leader; makes the party), `party_invite {party, from}` to the invitee,
  `party_accept` / `party_decline {party}`, `party_leave`, `party_chat {text}` -> `party_chat {from, text}`,
  `party_set {civ}`, `party {party: {id, leader, members, invited, messages}}`. The leader's `queue_join` (team queue)
  queues the whole party as one ticket: its members land on one team; a member leaving takes the ticket out; a party
  member's decline keeps the party together (no cooldown among its own members). Offline members stay in the party.
- **Match history and replays**: `history {name?}` -> every match with its players, outcomes, shown ratings and whether
  a replay is kept. The game client records its replay of a matchmade game and sends it at the game's end:
  `replay_chunk {match, offset, data (base64), last}` (players of the match only; the longest is kept) ->
  `replay_stored`; `replay_get {match}` -> `replay_chunk` messages to anyone logged in.
- **Lobbies**: a civilisation per player (`civ` on `room_create` / `room_join`, `room_set {civ, team}`), the host's
  settings (`room_settings {map, popCap, startAge, reveal}`); `match_start` carries `players[].civ` and `settings`.
- **Lobby passwords**: `room_create {..., password}` (1 to 64 characters; kept as a scrypt hash in memory, never sent
  back); `rooms` and `room` show `locked: true`; `room_join {room, password}` refuses a wrong one ("wrong lobby
  password"); tries per address are limited (`limits.roomPasswordPerIpPerMinute`). The host never needs it.
- **Lobby search**: `rooms` with any of `query` (in the room's or the host's name), `hideFull`, `hideLocked`, `ranked`
  (true / false), `map`, `pool`, `maxPlayers` (at most), `fitsMe` (the caller's rating is inside the room's window)
  answers only the rooms that pass, with `filtered: true`. `rooms` without them, and the lists pushed when a lobby
  changes, are the whole list as before.
- **Host controls** (the host, while the lobby is open): `room_kick {name}` (-> `room_kicked {room, by}` and `room
  {room: null}` to that player, who cannot join that lobby again), `room_move {name, slot?, team?}` (a free slot, or
  swap with the player there; team 1 to 4 in team lobbies), `room_slot {slot, state: open|closed|ai, difficulty?, civ?,
  team?}` (closing or filling slots lowers the room's `capacity`; computer players only in unranked lobbies),
  `room_host {name}` (hand the lobby on). A host who leaves before the start passes it to the next player. `room`
  carries `capacity` and `slots: [{slot, state: open|closed|player|ai, name?, team?, difficulty?, civ?}]`; computer
  players are in `slots`, not in `players`.
- **Computer players**: `match_start`'s `players[]` lists them after the humans with `ai: true`, `difficulty`
  (`easiest`, `easy`, `moderate`, `hard`, `hardest`), `civ`, `team` and `rating: null`; the host's game runs them and
  only humans report. A result where humans did not win and lose against each other is recorded as `vs_ai`.
- **FFA placings**: a result may carry `places {slot: place}`; the FFA rating is pairwise by place.
- **The control link comes back**: `resume {token}` during a running match: the player is no longer counted as gone
  (`match_resumed`), its report counts again.

## Moderation

Three roles: `player` (everyone), `moderator`, `admin`. Nobody acts on an account of their own rank or above.
Moderators give timed bans (at most `moderation.moderatorMaxBanDays`) and timed mutes, kick, resolve reports, look
players up and broadcast; admins also give permanent and address bans and make moderators. Admins are made only at the
server: the config's `moderation.admins` (account names; only accounts that already exist are made admins at start, so
register the account first; a name not yet registered is never reserved for whoever takes it) or the command line:

```
node src/admin.mjs role NAME admin            # in the container: docker exec swgb-matchmaking node src/admin.mjs ...
node src/admin.mjs ban NAME --minutes 1440 --reason "cheating"     # --minutes 0 or none: permanent; --address: also the address
node src/admin.mjs mute NAME --minutes 60 --scope dm --reason "insults"
node src/admin.mjs unban NAME | unmute NAME | ban-address IP ... | unban-address IP
node src/admin.mjs reports [open|dismissed|actioned|all] | resolve ID dismiss|actioned [--note TEXT]
node src/admin.mjs bans | mutes | staff | audit [N] | lookup NAME
```

The command line works on the database file (the config's `db`, or `--db FILE`) and acts as the operator (above
every role); a running server picks up its bans within `moderation.sweepSeconds` and closes those players'
connections. Mutes and roles apply at once.

- A **banned** player is refused at `login` / `resume` with `{t: "error", message: "you are banned until ... UTC:
  reason", banned: {until, reason}}` (`until` null: permanent), only after the right password. A player online when
  banned gets `banned {until, reason}` and the connection closes. An address ban refuses new accounts from that
  address and every player account logging in from it (moderators and admins excepted, who may share an address).
- A **muted** player's `room_chat` / `party_chat` (scope `chat`), `dm` (scope `dm`) or both (scope `all`) are refused
  with `{t: "error", message: "you are muted until ...: reason", muted: {scope, until, reason}}`; `muted {scope, until,
  reason}` and `unmuted` tell the player.
- `auth` carries `role`.
- **Reports**: `report_player {name, reason, match?}` (a match the reporter played) -> `report_filed {id}`; at most
  `moderation.reportsPerHour` per reporter. Moderators online get `mod_report {report}`.
- Moderator requests (answered with `mod_done {action, ...}` or the list): `mod_ban {name, minutes, reason, address?}`,
  `mod_unban {name}`, `mod_mute {name, minutes, scope: chat|dm|all, reason}`, `mod_unmute {name}`, `mod_kick {name,
  reason}` (-> `kicked {reason}` to the player), `mod_role {name, role: player|moderator}` (admins),
  `mod_broadcast {text}` (-> `broadcast {from, text, at}` to everyone online), `mod_reports {status?}` ->
  `mod_reports {reports}`, `mod_report_resolve {id, action: dismiss|actioned, note?}`, `mod_bans` -> `mod_bans {bans}`,
  `mod_mutes` -> `mod_mutes {mutes}`, `mod_audit {limit?, before?}` -> `mod_audit {entries}`, `mod_lookup {name}` ->
  `mod_lookup {player: {name, role, online, ban, bans, mutes, reports, address (admins only)}}`. Moderators see that a
  ban covers an address, not the address.

The tables (`player_roles`, `player_addresses`, `bans`, `mutes`, `reports`, `audit_log`) are new ones, so an older
image of the server still opens the database. `player_addresses` keeps each account's last log-in address, for address
bans of a player who is offline; it is shown to admins only.

## Admin dashboard

`admin.enabled: true` starts it on `admin.host:admin.port` (127.0.0.1:4319). Log in with an admin account's own name
and password. No scripts: server-rendered pages and forms.

- `/admin`: online players (kick), queues, live matches, lobbies, recent results, a broadcast to everyone online.
- `/admin/reports`: the reports queue (open / actioned / dismissed / all); ban or mute the reported player (the report
  becomes actioned) or dismiss it with a note.
- `/admin/sanctions`: active bans and mutes (lift), ban / mute / set a moderator by name, the staff list.
- `/admin/audit`: the audit log, newest first.
- `/admin/api/overview`: the overview as JSON (same session).

The session is a random token kept in memory (a restart logs everyone out) in a cookie that is `HttpOnly`,
`SameSite=Strict`, `Path=/admin` and, with `admin.secureCookie: "auto"`, `Secure` whenever the request came over TLS
(with `admin.trustProxy`, a reverse proxy's `X-Forwarded-Proto: https`); every form carries the session's CSRF token,
and every request checks again that the account is still an admin. Log-in attempts are limited per address
(`admin.loginPerIpPerMinute`) and share the game's lock-out per account name. Pages are sent with a strict
Content-Security-Policy, `X-Frame-Options: DENY` and `Cache-Control: no-store`.

## Public pages and API

`web.enabled: true` starts a read-only HTTP listener on `web.host:web.port` (127.0.0.1:4320):

| Page | JSON | What |
|---|---|---|
| `/leaderboard/solo` (`team`, `ffa`; `?limit=` up to 100) | `/api/leaderboard/solo` | `{pool, rows: [{rank, name, rating, wins, losses, streak, division}]}` |
| `/players/NAME` | `/api/players/NAME` | `{name, ratings: {pool: {rating, peak, wins, losses, streak, division, rank}}, recent: [match]}` |
| `/matches/ID` | `/api/matches/ID` | `{id, kind, queue, pool, map, ranked, week, status, createdAt, completedAt, replay, replayUrl?, players: [{name, slot, team, outcome, ratingBefore, ratingAfter}]}` |
| `/matches/ID/replay` | | the stored replay as a download, only with `web.replays: true` |
| `/tournaments`, `/tournaments/ID` | `/api/tournaments`, `/api/tournaments/ID` | the tournaments and their brackets |

Only what any logged-in player already sees in the game: never an address, an account id, a session, a report, a
moderation record or the hidden casual ratings. GET and HEAD only; `Cache-Control: public, max-age=web.cacheSeconds`;
the JSON has `Access-Control-Allow-Origin: *` (community sites may read it); at most `web.requestsPerMinute` per address
(429 with `Retry-After`).

## Discord notices

`discord.webhookUrl` (a channel webhook, `https://` only; empty by default: off) turns on two posts, after Empire
League's notifier: "Looking for a ranked 1v1" when a player (not a party) joins the ranked 1v1 queue
(`discord.queueNotices`), and "Ranked 1v1 result" with both new ratings and the map when a ranked 1v1 result is
confirmed (`discord.resultNotices`; it links to the public match page when `discord.siteUrl` is set). Names are
escaped and mentions are switched off; no address, report or moderation detail is ever posted. At most
`discord.perPlayerPerHour` posts name one player. Posts go out one at a time in the background with retries on 429 /
5xx; a failure is logged (`discord_failed`) and never affects a match.

## Tournaments

Single elimination, 1v1. A moderator or admin creates one; players register during its window; at the window's end
(or `tournament_start` by staff) the players are seeded by their 1v1 rating into a bracket of the next power of two
(seed 1 meets seed 2 only in the final; byes go to the top seeds). The server offers each ready match as a
`match_found` (with `match.tournament: {id, name, round, position}`, kind `tournament`) as soon as both players are
online and not in another match (it takes them out of a queue or an open lobby); then `accept`, `match_start`, the
game and the usual `result` flow. Tournament games change no rating.

- An offer that is declined or not accepted in time is made again after `tournaments.retrySeconds`. A player who is not
  there `noShowMinutes` after the match became ready loses by **walkover** to one who was (accepted an offer, or is
  online and free); if both or neither were, the one who accepted wins, else the higher seed.
- A **contested** result makes the match `disputed`; staff online get `tournament_disputed {id, round, position,
  match}` and settle it with `tournament_set_winner`.
- Requests: `tournaments` -> `tournaments {tournaments: [{id, name, status: registration|running|completed|cancelled,
  players, maxPlayers, maxRating, locked, registrationEndsAt, startedAt, completedAt, winner}]}`; `tournament_get {id}`
  -> `tournament {tournament}` (the summary plus `maps` per round, `noShowMinutes`, `players: [{name, rating, seed}]`,
  `bracket: [{round, position, player1, player2, winner, status: waiting|ready|playing|done|walkover|bye|disputed|cancelled,
  match, map, readyAt}]`, and `chat` for its players and staff); `tournament_join {id, password?}` (refused above
  `maxRating` or with a wrong password; tries per address limited as lobby passwords are), `tournament_leave {id}`
  (registration only), `tournament_chat {id, text}` -> `tournament_chat {id, from, text, at}` to its players (mutes
  and the chat rate apply). Registered players online get `tournament {tournament}` whenever it changes.
- Staff: `tournament_create {name, maxPlayers (2..tournaments.maxPlayers), registrationMinutes, noShowMinutes?,
  maxRating?, password?, maps?: [map id per round; the last repeats]}`, `tournament_start {id}`, `tournament_cancel
  {id}`, `tournament_set_winner {id, round, position, winner}`; each is in the audit log.
- Public: `/tournaments`, `/tournaments/ID` and `/api/tournaments[/ID]` on the public listener (no chat).
- Tables `tournaments`, `tournament_players`, `tournament_matches` (new ones). After a restart a match that was being
  offered or played is offered again (its game, if it was running, is not counted).
- Not done yet: team tournaments, double elimination, spectating a tournament match (the game has no observer slot in
  the server's brokering), check-in before the start.

## Seasons

Off unless `seasons.enabled`. A season is a calendar quarter in UTC (`2026-Q4`). The server opens the current one
when it first runs with seasons on; when a quarter has ended (checked every `seasons.checkMinutes`) it keeps every
shown rating (solo, team, FFA) of each player who played that season as a record (rating, peak, wins, losses, rank)
and soft-resets the rating to `1000 + (rating - 1000) * seasons.softReset` (0.5 by default), with peak, wins, losses
and streak starting again. Hidden casual ratings are not touched.

- `seasons` -> `seasons {enabled, current, seasons: [{id, startedAt, closedAt}]}`; `season {season, pool}` ->
  `season {season, pool, rows: [{rank, name, rating, peak, wins, losses, division}]}` (a closed season's final
  standings); `season_records {name?}` -> `season_records {name, records: [{season, pool, rating, peak, wins, losses,
  rank, division}]}`.
- Public: `/seasons`, `/seasons/ID/POOL` (and under `/api`); a player's page lists past seasons.
- Tables `seasons`, `season_records` (new). The reset itself writes the `ratings` rows, so rolling back to an older
  image after a reset keeps the reset ratings (the records stay in the new tables).

## Protocol

Newline-delimited JSON on the TCP port; every message has `t`. Requests: `hello`, `register`, `login`, `resume`,
`profile` (`name` optional), `leaderboard` (`pool`), `maps`, `weekly`, `queue_join`, `queue_leave`, `accept`,
`decline`, `rooms`, `room_create`, `room_join`, `room_leave`, `room_chat`, `room_ready`, `room_start`, `room_set`,
`room_settings`, `friends`, `friend_add`, `friend_accept`, `friend_remove`, `dm`, `dm_history`, `presence`,
`party_invite`, `party_accept`, `party_decline`, `party_leave`, `party_chat`, `party_set`, `history`, `replay_chunk`,
`replay_get`, `room_kick`, `room_move`, `room_slot`, `room_host`, `host_addr`, `punch_request`, `relay_request`, `link`, `result`, `report_player`, `mod_ban`, `mod_unban`,
`mod_mute`, `mod_unmute`, `mod_kick`, `mod_role`, `mod_broadcast`, `mod_reports`, `mod_report_resolve`, `mod_bans`,
`mod_mutes`, `mod_audit`, `mod_lookup`, `tournaments`, `tournament_get`, `tournament_create`, `tournament_start`,
`tournament_cancel`, `tournament_set_winner`, `tournament_join`, `tournament_leave`, `tournament_chat`, `seasons`,
`season`, `season_records`. Events: `welcome`, `auth`, `profile`,
`leaderboard`, `maps`, `weekly`, `queue`, `match_found`, `match_accepted`, `match_cancelled`, `match_start`,
`match_resumed`, `connect`, `punch`, `relay`, `rooms`, `room`, `chat`, `friends`, `friend_request`, `presence`, `dm`,
`dm_history`, `party`, `party_invite`, `party_invite_closed`, `party_chat`, `history`, `replay_chunk`,
`replay_stored`, `result_recorded`, `room_kicked`, `banned`, `kicked`, `muted`, `unmuted`, `broadcast`, `report_filed`, `mod_report`,
`mod_done`, `mod_reports`, `mod_bans`, `mod_mutes`, `mod_audit`, `mod_lookup`, `tournaments`, `tournament`,
`tournament_chat`, `tournament_disputed`, `seasons`, `season`, `season_records`, `error`.

A connection whose first line is `{"t":"relay","token":...}` becomes a byte pipe to its partner. On the UDP port the
rendezvous takes `{"t":"reg","token","slot"}` and answers `{"t":"wait"}` until both sides are there, then
`{"t":"peer","ip","port"}` to each.
