# Deploying Forked — free, single-origin on an Oracle Always-Free VM

Goal: a live demo at **https://forkedchess.site**, $0/month, persistent.

**Architecture:** one VM runs FastAPI, which serves both the API *and* the built
React app (single-origin → no CORS, relative `/api` + same-origin `wss://` just
work). **Caddy** sits in front for automatic free HTTPS and WebSocket proxying.

> Already done in code for you: single-origin static serving (`backend/main.py`),
> env-aware WebSocket URLs (`frontend/src/api/ws.ts`), `STOCKFISH_PATH` env
> override, and `.env` is gitignored. You only need to do the VM steps below.

---

## 1. Provision the VM (Oracle Cloud, free)

- Create an **Always Free** instance → **Ampere A1 (ARM)**, shape e.g. **2–4 OCPU
  / 12–24 GB RAM**, image **Ubuntu 22.04**. (Plenty for torch + Maia2 + Stockfish.)
- Save the SSH key. Note the **public IP**.
- **Networking → VCN → Security List → Ingress rules:** allow TCP **80** and
  **443** from `0.0.0.0/0` (22 is open by default).

## 2. Point the domain

At your registrar for `forkedchess.site`, add **A records**:
```
@     A   <VM_PUBLIC_IP>
www   A   <VM_PUBLIC_IP>
```
(DNS can take a few minutes to propagate.)

## 3. SSH in + open the OS firewall

Oracle's Ubuntu image ships with a restrictive iptables — open 80/443:
```bash
ssh ubuntu@<VM_PUBLIC_IP>
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 4. System packages

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip git stockfish nodejs npm debian-keyring debian-archive-keyring apt-transport-https curl
# Caddy (auto-HTTPS reverse proxy):
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
stockfish --help >/dev/null 2>&1 || which stockfish   # confirm: usually /usr/games/stockfish
```

## 5. Get the code + data

```bash
cd ~ && git clone https://github.com/ShahuPatil07/Forked.git forked
cd forked
```
Then copy the **large/gitignored assets** from your machine (they aren't in git):
```bash
# from your LOCAL machine:
scp -r models                ubuntu@<IP>:~/forked/
scp -r data/puzzles          ubuntu@<IP>:~/forked/data/
scp data/opening_knowledge.json data/endgame_knowledge.json data/endgame_positions.json ubuntu@<IP>:~/forked/data/
```
(`data/output/` is created at runtime; user profiles will persist on this VM's disk.)

## 6. Python env + deps

```bash
cd ~/forked
python3 -m venv .venv && source .venv/bin/activate
pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cpu   # aarch64 CPU wheel
pip install -r requirements.txt
```

## 7. Secrets (`.env` in project root)

```bash
cat > ~/forked/.env <<'EOF'
GROQ_API_KEY=gsk_your_key_here
LICHESS_TOKEN=lip_your_token_here
STOCKFISH_PATH=/usr/games/stockfish
EOF
```

## 8. Build the frontend (served single-origin)

```bash
cd ~/forked/frontend
npm ci && npm run build      # produces frontend/dist → FastAPI serves it
```

## 9. Run the API as a service (single worker — important)

> Use **one** worker: the bot-game state, Maia singleton, and live-sync scheduler
> are in-process. Multiple workers would duplicate/ break them.

```bash
sudo tee /etc/systemd/system/forked.service >/dev/null <<EOF
[Unit]
Description=Forked API
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/forked
EnvironmentFile=/home/ubuntu/forked/.env
ExecStart=/home/ubuntu/forked/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1 --timeout-keep-alive 75
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now forked
sudo systemctl status forked --no-pager     # should be active (running)
journalctl -u forked -f                      # watch logs (first Maia load is slow)
```

## 10. Caddy → HTTPS + reverse proxy

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
forkedchess.site, www.forkedchess.site {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8000
}
EOF
sudo systemctl restart caddy
```
Caddy auto-fetches a Let's Encrypt cert and proxies WebSockets transparently.

## 11. Verify

Open **https://forkedchess.site** → analyse a username (e.g. `ShahuPatil27`),
open the dashboard, play a Maia game (tests `wss://`), try the coach.

---

## Updating later
```bash
cd ~/forked && git pull
source .venv/bin/activate && pip install -r requirements.txt
cd frontend && npm ci && npm run build && cd ..
sudo systemctl restart forked
```

## Known caveats for this "quick demo"
- **Single worker** by design (don't add `--workers N`).
- **First request is slow** — Maia2 + the transformer load lazily on first use.
- **Shared Groq key** (30 RPM / 14.4k-day across *all* visitors) and **anyone can
  submit any username** to trigger heavy CPU ingestion. Fine for a quiet beta; add
  rate-limiting before promoting widely.
- **Mobile**: the app shell isn't responsive yet (landing page is). Desktop-first.
- **ARM note**: if any wheel fails to build on aarch64 (rare: `numba`/`llvmlite`
  via `umap-learn`), `pip install --upgrade` usually resolves it; or use an x86
  Always-Free shape instead.
- Data persists on the VM disk (survives restarts) — back up `data/output/` if it
  matters.
