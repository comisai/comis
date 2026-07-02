#!/usr/bin/env bash
# One-command stand-up of the AUTONOMOUS multi-signal trading system on the emulator rig.
# Sends the §Setup-prompt from targets/EXAMPLE-autonomous-trading-system.md to the agent via the Telegram
# emulator, then VERIFIES the four setup oracles in GROUND TRUTH (never the chat reply):
#   MCP-1  yfinance MCP connected (~20 tools)   ·  LEDGER-1  trading/portfolio.json on disk
#   STRAT-1 strategy stored in memory           ·  CRON-1    trading-cycle cron registered + scheduled
#
#   Usage:  bash setup-trading-system.sh            # stand up + verify
#           bash setup-trading-system.sh --bootstrap # also run CYCLE 1 to build the initial book
#           CHATID=… VPS=… bash setup-trading-system.sh   # override rig
#
# For a NON-emulator Comis (real Telegram etc.): don't use this script — paste the §Setup-prompt from
# targets/EXAMPLE-autonomous-trading-system.md into the chat as an ADMIN-trust sender (see the doc's
# Prerequisites). This script is the emulator-rig automation.
#
# NOTE: the prompt below is kept BYTE-IN-SYNC with the target doc's §Setup-prompt. If you edit one, edit both.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
VPS="${VPS:?set VPS=user@host in scripts/.live-env}"
CHATID="${CHATID:-678314278}"
DATA="${DATA:-/home/comis/.comis}"
GWTOKEN="${GWTOKEN:?set GWTOKEN in scripts/.live-env}"
BOOTSTRAP=0; [ "${1:-}" = "--bootstrap" ] && BOOTSTRAP=1

echo "== 1/4 sending the setup prompt to chat $CHATID on $VPS =="
# Pipe the prompt over ssh stdin → a VPS temp file (avoids local→ssh→su quote-hell; the kit gotcha).
ssh -o ConnectTimeout=15 "$VPS" 'cat > /tmp/trading-setup.txt' <<'PROMPT_EOF'
Set up a complete AUTONOMOUS multi-signal PAPER-trading system on this Comis instance. Do all four steps below, then confirm each. This is a paper simulation — never place real-money orders or move real funds.

STEP 1 — INSTALL MARKET-DATA TOOLS (MCP). Connect the yfinance MCP server for real market data. It's published to npm as "yfinance-mcp-ts", runs over stdio, needs NO API key. Use your MCP management tool to register it with command "npx" and args ["yfinance-mcp-ts"], name it "yfinance", connect it, and confirm it's connected and how many tools it exposes (~20: get_stock_price, get_stock_history, get_financials, get_key_stats, get_earnings, get_recommendations, get_stock_summary, search_stocks, get_market_summary, etc.). For news/sentiment you'll use your web_search tool — if web_search isn't available, say so and treat news as neutral.

STEP 2 — CREATE THE PORTFOLIO LEDGER. Write a file trading/portfolio.json in your workspace with: starting_cash 100000, cash 100000, currency "USD", positions {}, trade_log [], cycle 0, watchlist ["NVDA","AMD","MSFT","GOOGL","TSLA"]. Tell me the absolute path.

STEP 3 — STORE THE STRATEGY IN MEMORY (durable). Store this multi-signal strategy: for each watchlist ticker, combine (a) TECHNICAL — price vs 50/200-day moving averages + recent momentum (yfinance get_stock_history); (b) FUNDAMENTAL — valuation P/E & PEG, margins, free cash flow, revenue growth, earnings (yfinance get_financials / get_key_stats / get_earnings); (c) ANALYST RECOMMENDATIONS (yfinance get_recommendations); (d) NEWS + SENTIMENT (web_search for recent catalysts — weight LOW unless a concrete, sourced catalyst). Rules: size positions by conviction and risk; always keep a ~20% cash buffer; and — key discipline — do NOT trade unless there is a genuine signal change (a price crossing a moving average, an analyst revision, an earnings result, or a real news catalyst) AND meaningful market time has passed. Never churn on noise.

STEP 4 — SCHEDULE THE AUTONOMOUS CYCLE (cron). Create a recurring cron job named "trading-cycle" on schedule "0 21 * * 1-5" (UTC — weekdays at US market close). Its scheduled prompt must tell you to run the next trading cycle: (1) read trading/portfolio.json; (2) recall from memory your open trade theses, the strategy, and prior lessons; (3) mark every open position to market with fresh yfinance prices and compute unrealized + total portfolio value vs the 100000 start; (4) self-grade each thesis (playing out / too early / invalidated) and record an OUTCOME and a concise LESSON LEARNED to memory; (5) re-run the full 4-signal analysis and ADJUST only on genuine signal changes — trim/exit invalidated names, add to strengthening ones, deploy the cash buffer only for a new high-conviction signal — keeping the ~20% buffer; (6) update trading/portfolio.json (positions with entry_price/shares/cost and unrealized_pnl, realized_pnl, total_value, increment cycle, append to trade_log); (7) message me here with total value + P&L, per-position P&L, any trades made, and the top lesson learned. Confirm the cron is registered and tell me its job id and next run time.

GUARDRAILS: Paper simulation only — no real orders, ever. Ground every decision in the actual tool data — never fabricate numbers. Be honest: over short horizons P&L is noise, not skill — say so rather than claiming performance.

After all four steps, do NOT run a trading cycle yet — just confirm each step is done.
PROMPT_EOF

# Drive it — long maxMs (install MCP + write files + store memory + create cron in one turn). $(cat) runs VPS-side.
ssh -o ConnectTimeout=15 -o ServerAliveInterval=8 "$VPS" \
  "node /root/drive.mjs $CHATID \"\$(cat /tmp/trading-setup.txt)\" 15000 480000 $DATA" 2>&1 | tail -4

echo "== 2/4 poll gateway-up (the MCP-connect config write may debounce a SIGUSR2 restart) =="
ssh -o ConnectTimeout=15 "$VPS" 'for i in $(seq 1 20); do ss -ltnp 2>/dev/null | grep -q :4766 && { echo "GW_UP"; break; }; sleep 2; done'
sleep 6  # let the MCP reconnect after any restart

echo "== 3/4 VERIFY the four setup oracles in ground truth =="
ssh -o ConnectTimeout=20 -o ServerAliveInterval=8 "$VPS" '
  export COMIS_CONFIG_PATHS='"$DATA"'/config.yaml COMIS_GATEWAY_TOKEN='"$GWTOKEN"'
  pass=0; fail=0
  # MCP-1
  m=$(node /root/revoke.mjs mcp.list 2>/dev/null | sed "s/^RESULT://" | node -e "try{const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const y=(d.servers||d).find(s=>s.name===\"yfinance\");console.log(y?y.status+\":\"+y.toolCount:\"absent\");}catch(e){console.log(\"err\")}")
  if echo "$m" | grep -q "^connected:"; then echo "  [PASS] MCP-1   yfinance $m"; pass=$((pass+1)); else echo "  [FAIL] MCP-1   yfinance = $m"; fail=$((fail+1)); fi
  # LEDGER-1
  F=$(find '"$DATA"'/workspace -name portfolio.json -path "*trading*" 2>/dev/null | head -1)
  if [ -n "$F" ] && grep -q "100000" "$F"; then echo "  [PASS] LEDGER-1 $F (cash 100000)"; pass=$((pass+1)); else echo "  [FAIL] LEDGER-1 portfolio.json missing/invalid"; fail=$((fail+1)); fi
  # STRAT-1
  # scan up to 500 rows (robust on a rig with accumulated memory — a 15-row sample false-FAILs after other memories pile up)
  s=$(sudo -u comis env HOME=/home/comis node /root/db.mjs pick memories content 500 2>/dev/null | grep -ci "TRADING STRATEGY")
  if [ "${s:-0}" -ge 1 ]; then echo "  [PASS] STRAT-1  strategy stored in memory"; pass=$((pass+1)); else echo "  [FAIL] STRAT-1  strategy memory row not found"; fail=$((fail+1)); fi
  # CRON-1
  c=$(node /root/revoke.mjs cron.list 2>/dev/null | sed "s/^RESULT://" | node -e "try{const d=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));const j=(d.jobs||d).find(x=>/trading-cycle/.test(x.name||\"\"));console.log(j?(j.schedule?.expr||\"?\")+\":\"+(j.enabled?\"on\":\"off\"):\"absent\");}catch(e){console.log(\"err\")}")
  if echo "$c" | grep -q ":on"; then echo "  [PASS] CRON-1   trading-cycle ($c)"; pass=$((pass+1)); else echo "  [FAIL] CRON-1   trading-cycle = $c"; fail=$((fail+1)); fi
  echo "== VERDICT: $pass/4 oracles PASS =="
  [ "$fail" -eq 0 ] && echo "GREEN — autonomous trading system stood up." || echo "RED — $fail oracle(s) failed (re-send the failed step, or check prerequisites in the target doc)."
'

if [ "$BOOTSTRAP" -eq 1 ]; then
  echo "== 4/4 --bootstrap: running CYCLE 1 to build the initial book =="
  ssh -o ConnectTimeout=15 -o ServerAliveInterval=8 "$VPS" \
    "node /root/drive.mjs $CHATID \"Run TRADING CYCLE 1 now to build the initial portfolio: for each watchlist ticker gather all four signals (technical, fundamental, analyst recs via yfinance; news/sentiment via web_search), combine into a per-ticker conviction, make your initial BUY decisions with position sizing, keep the ~20 percent cash buffer, record entry prices and a one-line thesis per position to memory, update trading/portfolio.json (cycle 1), and report the portfolio with your thesis per name.\" 12000 480000 $DATA" 2>&1 | tail -6
else
  echo "== done (no --bootstrap: the cron will build the book at the next weekday 21:00 UTC; or re-run with --bootstrap) =="
fi
