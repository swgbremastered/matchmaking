# Hosting a matchmaking server

This guide runs the server as a Docker container on a Linux host that players can reach from the internet, under a
name such as `swgb.example.com`. Replace the example names and addresses with your own.

The game client has a built-in default server address. To use your server instead, players type its address in the
**Server** field of the Online log-in screen (the client remembers it), or start the game with
`--mm-server swgb.example.com:4317` for one run.

## What runs

| Port | Protocol | What | Public |
|---|---|---|---|
| 4317 | TCP | the control link (TLS: log-in, queues, lobbies, chat, results, replays) and the relay (plain: the game's own frames) | yes |
| 4317 | UDP | the hole-punch rendezvous | yes |
| 4318 | TCP (HTTP) | `GET /health`, the status as JSON | no: 127.0.0.1 inside the container only (Docker's health check) |
| 4319 | TCP (HTTP) | the admin dashboard (`admin.enabled`, off by default) | no: the host's 127.0.0.1 only, reached over SSH or a TLS reverse proxy |

- **TLS**: the server speaks TLS 1.2+ on its TCP port. The game client checks the certificate against the Windows
  certificate store and the host name it was given. A plain connection may only open a relay, so no password ever
  crosses in the clear.
- **Data**: one SQLite file, `/data/matchmaking.db` (accounts with scrypt password hashes, session-token hashes,
  ratings, matches, friends, messages, replays), in a named volume.
- **Logs**: JSON lines on stdout (`docker logs swgb-matchmaking`): log-ins, refusals with their reason, the client
  address; never a password or a token.
- **Limits**: see `limits`, `accounts`, `replays` and `messages` in `config.example.json` (connections in all and per
  address, message size, log-in deadline, message, log-in, registration and chat rates, a lock-out after failed
  log-ins, name and password rules, an account cap, replay size and retention).

## 1. The image

Images are built by GitHub Actions on every push to `main` and published to GitHub's container registry:

- `ghcr.io/swgbremastered/matchmaking:<version>-<8-char commit>`, for example `0.2.0-1a2b3c4d`: pin one of these;
- `ghcr.io/swgbremastered/matchmaking:main`: moves with every push; do not deploy it.

To build your own instead: `bash scripts/publish-image.sh` (runs the tests, builds, starts the image once and checks
its health), then `REGISTRY=registry.example.com/you bash scripts/publish-image.sh --push`. It always uses an exact tag,
never `latest`.

The image is based on `node:22-alpine` and runs as the non-root user `node` (uid 1000). Its built-in config is
`config.example.json` (TLS on, certificate at `/certs/fullchain.pem` and `/certs/privkey.pem`, database in `/data`).

## 2. The certificate

The server needs a publicly trusted certificate whose names include your server's name (`swgb.example.com`, or a
wildcard such as `*.example.com`), for example from Let's Encrypt. Any ACME client works; a DNS challenge needs no
open port 80.

- Put the PEM files where the container mounts them: `/opt/swgb/certs/fullchain.pem` and `/opt/swgb/certs/privkey.pem`.
- The key must be readable by uid 1000 (the container's user): `chown 1000:1000` and `chmod 600` the files, and
  `chmod 700` the folder.
- Have your ACME client's deploy hook copy the renewed files there. The server checks the files every
  `tls.reloadSeconds` (60) and uses a changed pair for new connections, so a renewal needs no restart. A pair that does
  not load (a half-written copy) is ignored and the old one stays in use.
- Do not mount a folder that holds other sites' keys into the container.

After a renewal the log shows `{"event":"tls_loaded",...,"validTo":...}` within a minute. `/health` reports
`tls.validTo` and turns unhealthy (503) once the certificate has expired.

## 3. Docker Compose

```yaml
services:
  swgb-matchmaking:
    image: ghcr.io/swgbremastered/matchmaking:0.2.0-1a2b3c4d   # an exact tag
    container_name: swgb-matchmaking
    restart: unless-stopped
    ports:
      - "4317:4317/tcp"
      - "4317:4317/udp"
    volumes:
      - swgb-mm-data:/data
      - /opt/swgb/certs:/certs:ro
    read_only: true
    tmpfs:
      - /tmp
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    mem_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

volumes:
  swgb-mm-data:
```

Do not publish port 4318. The image has its own `HEALTHCHECK`.

To change an option, mount a config file over the built-in one (`- /opt/swgb/config.json:/app/config.json:ro`). Start
from `config.example.json`; a file may give only the keys it changes, and the rest keep their defaults.

Start it and check:

```
docker compose up -d
docker ps --filter name=swgb-matchmaking            # STATUS ... (healthy)
docker exec swgb-matchmaking wget -q -O - http://127.0.0.1:4318/health
docker logs --tail 20 swgb-matchmaking              # {"event":"tls_loaded",...} {"event":"listening",...,"tls":true}
```

### Real client addresses

The per-address limits need the players' real addresses. Docker's published ports normally keep the source address
of traffic from outside. If the logs show every player with the Docker bridge's gateway address (the userland proxy is
in use), set `"userland-proxy": false` in `/etc/docker/daemon.json`, or run the service with `network_mode: host`
(and drop `ports:`). Do not put the server behind a proxy or load balancer that hides the client address.

## 4. Router / firewall

Forward TCP **and** UDP port 4317 from your public address to the Docker host (port 4317), and allow that traffic in
the firewall. Do not forward 4318.

To test from outside your network:

```
node src/cli.mjs --server swgb.example.com:4317 --tls maps
```

Players inside your own network reach the server by its public name only if the router supports NAT reflection
(hairpin NAT), or if your local DNS answers the name with the host's local address (the certificate still matches,
because the name is the same).

## 5. DNS

Create a public `A` record (and `AAAA` if you serve IPv6) for `swgb.example.com` pointing at your public address, or a
`CNAME` to a dynamic-DNS name. The name must resolve to your address directly: a proxy service that only carries HTTP
(for example Cloudflare's orange-cloud proxy) cannot carry TCP and UDP 4317, so set such a record to DNS only.

## 6. Backups

The database is the only state; the certificate can be renewed and the image pulled again. `src/backup.mjs` makes a
consistent copy while the server runs (SQLite `VACUUM INTO`). For example, daily from the host's root crontab, keeping
14 copies:

```
15 4 * * * docker exec swgb-matchmaking node src/backup.mjs /data/backups/matchmaking-$(date +\%F).db && docker exec swgb-matchmaking sh -c 'ls -1t /data/backups/*.db | tail -n +15 | xargs -r rm --' && docker cp swgb-matchmaking:/data/backups/. /opt/swgb/backups/
```

Include `/opt/swgb/backups` in the host's regular backup. The copies hold password hashes, session-token hashes and
each account's last log-in address (for address bans): keep them as private as the database.

Restore: stop the container, copy a backup into the volume as `/data/matchmaking.db` (remove `matchmaking.db-wal` and
`matchmaking.db-shm`), start it.

## 7. Moderators and admins

Register your own account in the game first, then make it an admin from the host:

```
docker exec swgb-matchmaking node src/admin.mjs role YOURNAME admin
```

(or list the name in the config's `moderation.admins` and restart: only an account that already exists is made an
admin). Admins make moderators in the game (`mod_role`), on the admin dashboard, or with `src/admin.mjs role NAME
moderator`. `src/admin.mjs` also bans, mutes and lists reports and the audit log (see README.md); it works while the
server runs.

### The admin dashboard

It is off by default and listens on 127.0.0.1. In the container, turn it on and let it listen on the container's
address, but publish it on the host's loopback only:

```json
{ "admin": { "enabled": true, "host": "0.0.0.0" } }
```

```yaml
    ports:
      - "127.0.0.1:4319:4319/tcp"
```

Then either reach it through an SSH tunnel (`ssh -L 4319:127.0.0.1:4319 you@swgb.example.com`, open
`http://127.0.0.1:4319/admin`), or put a TLS reverse proxy on the same host in front of it (for example
`https://admin.swgb.example.com/` -> `http://127.0.0.1:4319`) and set `"trustProxy": true` so the session cookie is
marked `Secure` and the per-address log-in limit sees the real address. Never publish 4319 on a public address
without TLS: the admin password would cross in the clear.

## 8. Upgrades and rollback

1. Pick the new image tag (`<version>-<commit>`; each workflow run prints it in its summary).
2. Take a backup (section 6).
3. Change the `image:` tag in the compose file and run `docker compose up -d`. Players online are disconnected and
   reconnect; a running game keeps going peer to peer and reports its result when its control link is back.
4. Check `docker ps` (healthy) and the logs.

Roll back by setting the previous tag again. Database changes only add columns and tables, which an older image
ignores; if a release says otherwise, restore the backup from step 2.

## The game client

- Address forms: `HOST[:PORT]` (TLS; plain TCP only to this computer: `localhost`, `127.x`), `tls://HOST:PORT`,
  `tcp://127.0.0.1:PORT`. Plain TCP to another computer is refused.
- `--mm-ca FILE`: trust a PEM certificate as the only root (a server with its own CA, or a test certificate).

## Local runs

```
node src/server.mjs --port 4400 --db build/mm.db --min-queue-ms 0 --test-maps --no-health          # plain, 127.0.0.1
node test/selfsigned.mjs build/tls localhost                                                        # a test certificate
node src/server.mjs --tls-cert build/tls/cert.pem --tls-key build/tls/key.pem --health-port 4418    # TLS
npm test
```
