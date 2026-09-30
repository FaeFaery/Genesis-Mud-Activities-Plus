// Font Awesome Injection
if (!document.getElementById('rpg-casino-fa')) {
    let faLink = document.createElement('link');
    faLink.id = 'rpg-casino-fa';
    faLink.rel = 'stylesheet';
    faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
    document.head.appendChild(faLink);
}

// Data Persistence & Currency Utilities
if (!CASINO_STORAGE_KEY) let CASINO_STORAGE_KEY = 'casinoDashboardData';
let defaultCasinoData = () => ({
    onjat: {
        wins: 0,
        losses: 0,
        netCopper: 0,
        history: [0],
        log: []
    },
    roulette: {
        netCopper: 0
    },
    dh: {
        wins: 0,
        losses: 0,
        pushes: 0,
        netCopper: 0,
        history: [0],
        log: []
    }
});

let casinoData;
try {
    let raw = window.localStorage.getItem(CASINO_STORAGE_KEY);
    casinoData = raw ? JSON.parse(raw) : defaultCasinoData();
} catch (err) {
    console.error('[Casino] Saved data unreadable, starting fresh:', err);
    casinoData = defaultCasinoData();
}
// Backfill any field missing from an older save (or a fresh one)
let casinoDefaults = defaultCasinoData();
casinoData.onjat = Object.assign(casinoDefaults.onjat, casinoData.onjat);
casinoData.roulette = Object.assign(casinoDefaults.roulette, casinoData.roulette);
casinoData.dh = Object.assign(casinoDefaults.dh, casinoData.dh);

let onjatState = casinoData.onjat;
let rouletteState = casinoData.roulette;
let dhState = casinoData.dh;

let saveCasinoData = () => {
    try {
        window.localStorage.setItem(CASINO_STORAGE_KEY, JSON.stringify(casinoData));
    } catch (err) {
        console.error('[Casino] Could not save data:', err);
    }
};

let currentBetCopper = 0;
let pendingWin = false;
let currentDrift = null;

let activeBets = {};
let spinTotalWagerCopper = 0;
let isRoundFinished = false;

let dhCurrentBetCopper = 0;
let dhPlayerHand = [];
let dhDealerHand = [];
let dhDealerHoleCardHidden = true;
let dhPlayerTotal = 0;
let dhIsSoft = false;
let dhRoundActive = false;
let dhOtherPlayers = {};

let dhAutoActive = false;
let dhAutoStopRequested = false;
let dhAutoIsFirstMove = true;
let dhAutoParams = {
    allowDouble: false,
    stopHandsEnabled: false,
    stopHands: 50,
    stopProfitEnabled: false,
    stopProfit: 200,
    stopLossEnabled: false,
    stopLoss: 200,
    stopMinutesEnabled: false,
    stopMinutes: 30,
};
let dhAutoHandsPlayed = 0;
let dhAutoStartTime = 0;
let dhAutoLastActedSig = '';
let dhAutoLastActedAt = 0;
let dhAutoLastAction = '';
let dhAutoAwaitingTurn = false;
let dhAutoDoubleOffered = false;
let dhAutoTurnTimer = null;
let DH_AUTO_DELAY_MIN_MS = 500;
let DH_AUTO_DELAY_MAX_MS = 1000;
let DH_AUTO_DEBUG = false;
let dhAutoStartNetCopper = 0;

let P_MULTIPLIER = 1728;
let G_MULTIPLIER = 144;
let S_MULTIPLIER = 12;
let CASINO_BET_CAP = 100;

let startOfLocalDay = (d) => {
    let x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
};
let PERIOD_DAYS_BACK = {
    '1d': 0,
    '1w': 6,
    '1m': 29
};

let dayKeyOf = (ts) => {
    let d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let getFilteredStats = (state, period, customDays, sourceFilter = 'all') => {
    let useCustomDays = period === 'custom' && customDays && customDays.size > 0;
    let daysBack = PERIOD_DAYS_BACK[period] || 0;
    let cutoff = period === 'all' ? 0 : startOfLocalDay(Date.now() - daysBack * 86400000);
    let entries = (state.log || []).filter(e => {
        let inWindow = useCustomDays ? customDays.has(dayKeyOf(e.ts)) : e.ts >= cutoff;
        if (!inWindow) return false;
        if (sourceFilter !== 'all' && (e.source || 'manual') !== sourceFilter) return false;
        return true;
    });

    let wins = 0,
        losses = 0,
        pushes = 0,
        net = 0;
    let history = [0];
    entries.forEach(e => {
        if (e.result === 'win') wins++;
        else if (e.result === 'loss') losses++;
        else if (e.result === 'push') pushes++;
        net += e.netChange;
        history.push(net);
    });

    let total = wins + losses;
    return {
        wins,
        losses,
        pushes,
        net,
        history,
        rate: total > 0 ? (wins / total) * 100 : 0
    };
};

let FA_DICE_CLASSES = ['', 'fa-dice-one', 'fa-dice-two', 'fa-dice-three', 'fa-dice-four', 'fa-dice-five', 'fa-dice-six'];

let getDieIcon = (val) => {
    let num = parseInt(val, 10);
    if (num >= 1 && num <= 6) {
        return `<i class="fa-solid ${FA_DICE_CLASSES[num]}"></i>`;
    }
    return val || '?';
};

let convertToCopper = (amount, unit) => {
    switch ((unit || '').toLowerCase()) {
        case 'platinum':
            return amount * P_MULTIPLIER;
        case 'gold':
            return amount * G_MULTIPLIER;
        case 'silver':
            return amount * S_MULTIPLIER;
        case 'copper':
            return amount;
        default:
            return 0;
    }
};

let parseTotalCopper = (text) => {
    let total = 0;
    let matches = text.matchAll(/(\d+)\s+(platinum|gold|silver|copper)/gi);
    for (let match of matches) {
        total += convertToCopper(parseInt(match[1], 10), match[2]);
    }
    return total;
};

let formatCurrency = (copperAmt, showSign = true) => {
    if (copperAmt === 0) return '0c';
    let isNegative = copperAmt < 0;
    let val = Math.abs(copperAmt);

    let p = Math.floor(val / P_MULTIPLIER);
    val %= P_MULTIPLIER;
    let g = Math.floor(val / G_MULTIPLIER);
    val %= G_MULTIPLIER;
    let s = Math.floor(val / S_MULTIPLIER);
    val %= S_MULTIPLIER;
    let c = val;

    let str = [];
    if (p) str.push(`${p}p`);
    if (g) str.push(`${g}g`);
    if (s) str.push(`${s}s`);
    if (c || str.length === 0) str.push(`${c}c`);

    if (!showSign) return str.join(' ');
    return (isNegative ? '-' : '+') + str.join(' ');
};

// Utility Functions
let sendCommand = (cmd) => {
    let inputEl = document.getElementById('input');
    let originalValue = inputEl.value;
    let selStart = inputEl.selectionStart;
    let selEnd = inputEl.selectionEnd;

    inputEl.value = cmd;
    let enterEvent = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        keyCode: 13,
        which: 13,
        key: 'Enter'
    });
    inputEl.dispatchEvent(enterEvent);

    inputEl.value = originalValue;
    if (selStart !== null) inputEl.setSelectionRange(selStart, selEnd);
};

// DOM Setup & Styles
let targetId = 'mudoutput';
let mudOutput = document.getElementById(targetId);

if (!mudOutput) {
    console.error('[Casino Dashboard] Could not find #mudoutput.');
} else {
    let rect = mudOutput.getBoundingClientRect();
    let scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    let scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

    if (document.getElementById('rpg-casino-dashboard')) document.getElementById('rpg-casino-dashboard').remove();
    if (document.getElementById('rpg-casino-styles')) document.getElementById('rpg-casino-styles').remove();
    if (window.casinoObserver) window.casinoObserver.disconnect();

    let styles = document.createElement('style');
    styles.id = 'rpg-casino-styles';
    styles.innerHTML = `
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700&display=swap');
  
      #rpg-casino-dashboard {
        position: absolute !important;
        top: ${rect.top + scrollTop}px !important;
        left: ${rect.left + scrollLeft}px !important;
        width: ${rect.width}px !important;
        height: ${Math.max(rect.height * 0.58, 460)}px !important;
        z-index: 2147483647 !important;
        display: block !important;
        font-family: 'Poppins', sans-serif;
        box-sizing: border-box;
        
        --c-black: #000000;
        --c-bg: #13563B;
        --c-gold: #E4A700;
        --c-white: #FFFFFF;
        --c-panel: rgba(0, 0, 0, 0.6);
        --c-gray: #bdc3c7;
        --c-green: #2ecc71;
        --c-red: #e74c3c;
        --r-crimson: #c0392b;
        --r-light: #ecf0f1;
        --r-green: #27ae60;
      }
  
      #rpg-casino-dashboard * { box-sizing: border-box; user-select: none; }
  
      .palanthas-container {
        width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
        background: linear-gradient(135deg, var(--c-bg) 0%, var(--c-black) 100%) !important;
        box-shadow: inset 0 0 40px rgba(0,0,0,0.6); position: relative; overflow: hidden !important; 
        padding: 14px 18px !important; border: 2px solid var(--c-gold); border-radius: 8px;
      }
  
      .close-dashboard {
        position: absolute; top: 10px; right: 12px; background: transparent !important; border: none !important;
        color: var(--c-white) !important; cursor: pointer; z-index: 10; padding: 4px; display: flex; align-items: center;
        justify-content: center; transition: color 0.2s; -webkit-box-shadow: none;
      }
      .close-dashboard:hover { color: var(--c-red) !important; }
  
      .palanthas-title {
        font-size: min(8vw, 34px) !important; font-weight: 700 !important; color: var(--c-gold) !important;
        margin: 0 0 2px 0 !important; letter-spacing: 4px !important; text-transform: uppercase !important;
        text-align: center; line-height: 1.1 !important; flex: 0 0 auto;
      }
      .palanthas-subtitle {
        font-size: min(2.5vw, 12px) !important; font-weight: 300 !important; color: var(--c-white) !important;
        margin: 0 0 14px 0 !important; letter-spacing: 6px !important; text-transform: uppercase !important;
        opacity: 0.8 !important; text-align: center; flex: 0 0 auto;
      }
  
      .palanthas-menu { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 280px; flex: 1 1 0; justify-content: center; padding-bottom: 8px; }
      .palanthas-btn {
        background: var(--c-black) !important; color: var(--c-white) !important; border: 1px solid var(--c-gold) !important;
        border-radius: 50px !important; font-size: min(3vw, 12px) !important; font-weight: 300 !important;
        text-transform: uppercase !important; letter-spacing: 3px !important; cursor: pointer !important;
        transition: background 0.2s, transform 0.1s, color 0.2s !important; width: 100% !important; text-align: center !important;
        flex: 1 1 0; max-height: 40px; min-height: 20px; display: flex; align-items: center; justify-content: center; padding: 0 16px !important;
      }
      .palanthas-btn:hover { background: var(--c-gold) !important; color: var(--c-black) !important; }

      .data-controls-row { display: flex; flex-direction: row; gap: 6px; width: 100%; max-width: 280px; margin-bottom: 6px; }
      .data-btn {
        background: transparent !important; color: var(--c-gold) !important; border: 1px solid rgba(228, 167, 0, 0.4) !important;
        border-radius: 6px !important; font-size: 8.5px !important; font-weight: 600 !important;
        text-transform: uppercase !important; letter-spacing: 1px !important; cursor: pointer !important;
        transition: background 0.2s, color 0.2s !important; flex: 1 1 0; height: 26px;
        display: flex; align-items: center; justify-content: center; padding: 0 4px !important;
      }
      .data-btn:hover { background: rgba(228, 167, 0, 0.15) !important; color: var(--c-white) !important; }
      .data-btn.danger:hover { background: rgba(231, 76, 60, 0.2) !important; color: #e74c3c !important; border-color: #e74c3c !important; }
  
      /* View Layouts */
      .view-container { width: 100%; height: 100%; display: none; flex-direction: column; gap: 6px; }
      .oj-header { display: flex; justify-content: space-between; align-items: center; flex: 0 0 auto; width: 100%; }
      .oj-back-btn { background: rgba(228, 167, 0, 0.15); border: 1px solid var(--c-gold); color: var(--c-gold); padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; letter-spacing: 1px; transition: all 0.2s; }
      .oj-back-btn:hover { background: var(--c-gold); color: var(--c-black); }
      
      /* Onjat Styles */
      .oj-arena { flex: 1 1 auto; min-height: 0; background: var(--c-panel); border: 1px solid rgba(228, 167, 0, 0.3); border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: space-evenly; padding: 6px 12px; }
      .oj-arena-status { font-size: 12px; font-weight: 400; letter-spacing: 1.5px; color: var(--c-white); text-transform: uppercase; text-align: center; }
      .oj-drift-display { display: flex; align-items: center; gap: 8px; opacity: 0.4; transition: opacity 0.3s; }
      .oj-drift-display.active { opacity: 1; }
      .oj-drift-label { font-size: 10px; color: var(--c-gold); letter-spacing: 1.5px; text-transform: uppercase; }
      
      .oj-die {
        width: 36px; height: 36px; background: #fff; color: #000; font-size: 30px; border-radius: 5px;
        display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; line-height: 1;
      }
      .oj-die.drift { background: #fff; color: #000; border: 1px solid rgba(228, 167, 0, 0.5); }
      
      .oj-matchup { display: flex; width: 100%; justify-content: space-around; align-items: center; }
      .oj-player-side { display: flex; flex-direction: column; align-items: center; gap: 2px; opacity: 0.4; transition: opacity 0.3s; width: 45%; }
      .oj-player-side.active { opacity: 1; }
      .oj-dice-row { display: flex; gap: 6px; }
      
      .oj-die.drift-match {
        background: #111 !important; color: #555 !important; opacity: 0.35;
        border: 1px dashed rgba(255, 255, 255, 0.25) !important; box-shadow: inset 0 0 6px #000;
      }
  
      .oj-arch-label { font-size: 11px; font-weight: 600; color: var(--c-white); letter-spacing: 1px; }
      .oj-arch-label.brix { color: var(--c-gold); text-shadow: 0 0 6px var(--c-gold); }
  
      /* Bet Controls */
      .oj-controls, .r-controls, .dh-controls { display: flex; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; margin: 2px 0; }
      .oj-stepper-box { display: flex; align-items: center; background: var(--c-black); border: 1px solid var(--c-gold); border-radius: 20px; padding: 2px 8px; }
      .oj-step-btn { background: transparent; border: none; color: var(--c-gold); font-size: 16px; font-weight: bold; cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; transition: color 0.15s; }
      .oj-step-btn:hover { color: var(--c-white); }
      .oj-bet-input { width: 55px; background: transparent; border: none; color: var(--c-white); text-align: center; font-family: inherit; font-size: 13px; font-weight: 600; outline: none; }
      .oj-bet-input::-webkit-outer-spin-button, .oj-bet-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .oj-bet-input[type=number] { -moz-appearance: textfield; }
      
      .unit-tag { font-size: 10px; color: var(--c-gold); font-weight: 600; text-transform: uppercase; margin: 0 16px 0 2px; }
  
      .oj-action-btn, .r-action-btn, .dh-action-btn { background: var(--c-black); color: var(--c-white); border: 1px solid var(--c-gold); padding: 5px 14px; border-radius: 20px; font-size: 10px; font-weight: 600; cursor: pointer; text-transform: uppercase; transition: 0.2s; }
      .oj-action-btn:hover, .r-action-btn:hover, .dh-action-btn:hover { background: var(--c-gold); color: var(--c-black); }
      .dh-action-btn.btn-double { border-color: #3498db; color: #3498db; }
      .dh-action-btn.btn-double:hover { background: #3498db; color: #fff; }
      .dh-action-btn.btn-auto { border-color: #2ecc71; color: #2ecc71; }
      .dh-action-btn.btn-auto:hover { background: #2ecc71; color: #fff; }
      .dh-action-btn.btn-auto.running { border-color: var(--c-red); color: var(--c-red); }
      .dh-action-btn.btn-auto.running:hover { background: var(--c-red); color: #fff; }

      /* Auto-Play Settings Modal */
      .dh-auto-modal-overlay {
        position: absolute; inset: 0; background: rgba(0,0,0,0.88); z-index: 50;
        display: flex; align-items: center; justify-content: center; border-radius: 8px; padding: 12px; box-sizing: border-box;
      }
      .dh-auto-modal {
        background: #0a0a0a; border: 1px solid var(--c-gold); border-radius: 8px; padding: 14px 16px;
        width: 100%; max-width: 250px; max-height: 100%; overflow-y: auto; display: flex; flex-direction: column; gap: 7px;
      }
      .dh-auto-modal-title { font-size: 12px; font-weight: 700; color: var(--c-gold); text-align: center; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
      .dh-auto-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--c-white); flex-wrap: wrap; }
      .dh-auto-row input[type="checkbox"] { accent-color: var(--c-gold); width: 13px; height: 13px; flex: 0 0 auto; }
      .dh-auto-num { width: 46px; background: var(--c-black); border: 1px solid rgba(228,167,0,0.4); border-radius: 4px; color: var(--c-white); text-align: center; font-size: 10.5px; padding: 2px 3px; }
      .dh-auto-section-label { font-size: 8.5px; color: var(--c-gold); letter-spacing: 1px; text-transform: uppercase; font-weight: 700; }
      .dh-auto-divider { height: 1px; background: rgba(255,255,255,0.15); margin: 2px 0; }
      .dh-auto-hint { font-size: 8px; color: var(--c-gray); line-height: 1.4; margin-top: 2px; }
      .dh-auto-modal-actions { display: flex; gap: 8px; justify-content: center; margin-top: 6px; }
  
      .oj-bottom-grid { display: flex; gap: 8px; flex: 0 0 105px; width: 100%; }
      .oj-stats-col { flex: 0 0 180px; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(3, 1fr); gap: 4px; height: 100%; }
      .oj-stat-box { background: var(--c-panel); border: 1px solid rgba(228, 167, 0, 0.25); border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2px 4px; text-align: center; }
      .oj-stat-box.wide { grid-column: span 2; }
      .oj-stat-label { font-size: 8.5px; color: var(--c-gray); text-transform: uppercase; letter-spacing: 0.8px; }
      .oj-stat-val { font-size: 11px; font-weight: 600; color: var(--c-white); }
      .oj-stat-val.win { color: var(--c-green); }
      .oj-stat-val.loss { color: var(--c-red); }
      .oj-stat-val.gold { color: var(--c-gold); }
      .oj-chart-col { flex: 1; background: var(--c-panel); border: 1px solid rgba(228, 167, 0, 0.25); border-radius: 4px; padding: 4px; position: relative; min-width: 0; height: 100%; }

      /* Stats Time Filter */
      .stat-filter-row { display: flex; gap: 4px; justify-content: center; flex: 0 0 auto; margin: 2px 0; }
      .stat-filter-row.overlay {
        position: absolute; top: 4px; left: 0; right: 0; margin: 0; z-index: 3; pointer-events: none; gap: 6px;
      }
      .stat-filter-row.overlay .stat-filter-btn { pointer-events: auto; }
      .stat-filter-row.overlay.source-row { top: 28px; }
      .stat-filter-row.overlay.source-row .stat-filter-btn { font-size: 8px; padding: 1.5px 6px; }
      .stat-filter-btn {
        background: rgba(0,0,0,0.75); color: var(--c-gray); border: 1px solid rgba(228, 167, 0, 0.4); border-radius: 10px;
        font-size: 10.5px; font-weight: 700; padding: 3px 11px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px; transition: 0.15s;
      }
      .stat-filter-btn:hover { border-color: var(--c-gold); color: var(--c-white); }
      .stat-filter-btn.active { background: var(--c-gold); color: var(--c-black); border-color: var(--c-gold); }

      /* Calendar Popup */
      .stat-cal-popup {
        position: absolute; top: 28px; left: 50%; transform: translateX(-50%); z-index: 10;
        background: #0a0a0a; border: 1px solid var(--c-gold); border-radius: 6px; padding: 6px;
        width: 176px; box-shadow: 0 4px 14px rgba(0,0,0,0.6); user-select: none;
      }
      #dh-cal-popup { top: auto; bottom: calc(100% - 28px); } 

      /* Dragon's Hand Stats */
      .dh-bottom-grid { flex: 0 0 105px; } /* same height as every other view; the felt table (not this) is what gives way if space is tight */
      .dh-bottom-grid .oj-stats-col { flex: 0 0 190px; gap: 3px; }
      .dh-bottom-grid .oj-stat-box { flex-direction: row; justify-content: space-between; gap: 6px; padding: 0 8px; }
      .dh-bottom-grid .oj-stat-label { font-size: 8px; }
      .dh-bottom-grid .oj-stat-val { font-size: 10.5px; }
      .dh-bottom-grid .oj-chart-col { container-type: inline-size; }
      .dh-chart-wrap { position: relative; width: 100%; height: 100%; padding-top: 26px; box-sizing: border-box; }
      #dh-stat-filter { justify-content: flex-start; padding-left: 6px; }
      #dh-source-filter.source-row { top: 4px; justify-content: flex-end; padding-right: 6px; }
      @container (max-width: 400px) {
        #dh-stat-filter { justify-content: center; padding-left: 0; }
        #dh-source-filter.source-row { top: 28px; justify-content: center; padding-right: 0; }
        .dh-chart-wrap { padding-top: 46px; }
      }
      .stat-cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; }
      .stat-cal-nav { background: transparent; border: none; color: var(--c-gold); font-size: 13px; font-weight: 700; cursor: pointer; padding: 0 6px; line-height: 1; }
      .stat-cal-nav:hover { color: var(--c-white); }
      .stat-cal-month-label { font-size: 9.5px; font-weight: 700; color: var(--c-white); text-transform: uppercase; letter-spacing: 0.5px; }
      .stat-cal-weekdays, .stat-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
      .stat-cal-weekdays { margin-bottom: 2px; }
      .stat-cal-weekdays span { font-size: 7.5px; color: var(--c-gray); text-align: center; font-weight: 600; }
      .stat-cal-day {
        display: flex; align-items: center; justify-content: center; height: 20px; font-size: 9px; color: var(--c-white);
        border-radius: 4px; cursor: pointer; background: rgba(255,255,255,0.04);
      }
      .stat-cal-day:hover { background: rgba(228, 167, 0, 0.25); }
      .stat-cal-day.selected { background: var(--c-gold); color: var(--c-black); font-weight: 700; }
      .stat-cal-day.today-default { background: rgba(228, 167, 0, 0.15); border: 1px dashed var(--c-gold); color: var(--c-white); font-weight: 700; }
      .stat-cal-day.empty { cursor: default; background: transparent; }
      .stat-cal-footer { display: flex; align-items: center; justify-content: flex-end; margin-top: 5px; }
      .stat-cal-clear {
        background: transparent; border: 1px solid rgba(231, 76, 60, 0.5); color: #ff9d8e; font-size: 8px; font-weight: 600;
        padding: 2px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap;
      }
      .stat-cal-clear:hover { background: rgba(231, 76, 60, 0.15); }
  
      /* Roulette Styles */
      .r-spinner-wrapper {
        width: 100%; height: 34px; background: #000; border: 2px solid var(--c-gold); border-radius: 4px;
        overflow: hidden; position: relative; margin-bottom: 2px; box-shadow: inset 0 0 15px rgba(0,0,0,0.8);
        display: flex; align-items: center; flex: 0 0 auto;
      }
      .r-spinner-indicator {
        position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; background: var(--c-gold);
        transform: translateX(-50%); z-index: 5; box-shadow: 0 0 10px var(--c-gold);
      }
      .r-spinner-track { display: flex; height: 100%; position: absolute; left: 50%; }
      .r-spinner-track.spinning { animation: spin-loop 0.8s linear infinite !important; }
      
      @keyframes spin-loop {
        0% { transform: translateX(-1500px); }
        100% { transform: translateX(-2980px); }
      }
  
      .r-pocket {
        width: 40px; height: 100%; display: flex; align-items: center; justify-content: center;
        font-weight: 700; color: #fff; border-right: 1px solid rgba(255,255,255,0.2); font-size: 12px;
      }
      .r-crimson { background-color: var(--r-crimson); }
      .r-light { background-color: var(--r-light); color: #000; }
      .r-nuitari { background-color: var(--r-green); }
  
      .r-board {
        flex: 1; display: grid; grid-template-columns: 38px repeat(12, 1fr) 38px;
        grid-template-rows: repeat(5, 1fr); gap: 2px; width: 100%; background: var(--c-panel); padding: 4px; border-radius: 6px;
      }
      .r-btn {
        display: flex; align-items: center; justify-content: center; background: transparent;
        border: 1px solid rgba(255,255,255,0.2); color: #fff; font-size: 10px; font-weight: 600; cursor: pointer;
        border-radius: 2px; transition: all 0.15s ease; position: relative;
      }
      .r-btn.crimson { background: var(--r-crimson); }
      .r-btn.light { background: var(--r-light); color: #000; }
      .r-btn.nuitari { background: var(--r-green); }
      
      .r-doz-btn { grid-column: span 4; background: rgba(255,255,255,0.05); }
      .r-doz-start-1 { grid-column: 2 / span 4; }
      .r-doz-start-2 { grid-column: 6 / span 4; }
      .r-doz-start-3 { grid-column: 10 / span 4; }
  
      .r-out-btn { grid-column: span 2; background: rgba(255,255,255,0.05); }
      .r-out-start-1 { grid-column: 2 / span 2; }
      .r-out-start-2 { grid-column: 4 / span 2; }
      .r-out-start-3 { grid-column: 6 / span 2; }
      .r-out-start-4 { grid-column: 8 / span 2; }
      .r-out-start-5 { grid-column: 10 / span 2; }
      .r-out-start-6 { grid-column: 12 / span 2; }
  
      .r-btn.hover-highlight {
        background-color: rgba(228, 167, 0, 0.35) !important; border-color: #E4A700 !important;
        box-shadow: 0 0 8px rgba(228, 167, 0, 0.7); z-index: 10;
      }
      .r-btn.bet-active { box-shadow: inset 0 0 0 2px #E4A700, 0 0 8px rgba(228, 167, 0, 0.8) !important; border-color: #E4A700 !important; font-weight: 700; }
      .r-btn.bet-active::after { content: '•'; position: absolute; top: 0px; right: 2px; color: #E4A700; font-size: 14px; line-height: 1; }
      .r-btn.bet-active-pocket { background-color: rgba(228, 167, 0, 0.18) !important; }
      .r-btn.winning-pocket { animation: pulse-win 1.2s infinite alternate; border: 2px solid #00ffff !important; z-index: 15; }
      
      @keyframes pulse-win {
        0% { box-shadow: 0 0 4px #00ffff, inset 0 0 6px #00ffff; }
        100% { box-shadow: 0 0 16px #00ffff, inset 0 0 12px #00ffff; }
      }
      .r-btn.bet-win { border: 2px solid #2ecc71 !important; background-color: rgba(46, 204, 113, 0.35) !important; box-shadow: 0 0 10px rgba(46, 204, 113, 0.7); color: #fff !important; }
      .r-btn.bet-loss { border: 2px solid #e74c3c !important; background-color: rgba(231, 76, 60, 0.25) !important; opacity: 0.6; }
  
      .r-chip-selector { display: flex; gap: 4px; flex: 0 0 auto; margin-right: 4px; }
      .r-chip {
        width: 26px; height: 26px; border-radius: 50%; font-size: 8.5px; font-weight: 700;
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        transition: transform 0.15s, box-shadow 0.15s; box-shadow: 0 2px 4px rgba(0,0,0,0.5);
        border: 2px dashed rgba(255,255,255,0.6); color: #fff; text-shadow: 0 1px 2px #000;
      }
      .r-chip:hover { transform: scale(1.1); }
      .r-chip.active { transform: scale(1.15); box-shadow: 0 0 10px var(--c-gold); border-style: solid; border-color: #fff; }
      .r-chip-10 { background: radial-gradient(circle, #2980b9 60%, #1f618d 100%); }
      .r-chip-50 { background: radial-gradient(circle, #c0392b 60%, #922b21 100%); }
      .r-chip-100 { background: radial-gradient(circle, #27ae60 60%, #1e8449 100%); }
  
      .r-summary-panel { display: flex; gap: 10px; width: 100%; flex: 0 0 42px; margin-top: 2px; }
      .r-summary-box { flex: 1; background: var(--c-panel); border: 1px solid rgba(228, 167, 0, 0.25); border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2px 6px; text-align: center; }
  
      /* Dragon's Hand Styles */
      /* Layout Budget */
      .dh-felt-table {
        flex: 1 1 auto; min-height: 0; background: var(--c-panel); border: 1px solid rgba(228, 167, 0, 0.3);
        border-radius: 6px; display: flex; flex-direction: column; gap: 4px; padding: 6px 12px 10px; position: relative;
        overflow: hidden;
      }
      .dh-sides-wrapper {
        display: flex; flex-direction: row; justify-content: space-between; align-items: stretch;
        gap: 12px; flex: 0 0 auto; width: 100%; margin: auto 0;
      }
      .dh-section {
        flex: 1 1 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
        gap: 4px; background: rgba(0, 0, 0, 0.25); border-radius: 6px; padding: 6px 8px 8px; border: 1px solid rgba(255, 255, 255, 0.05); min-width: 0;
      }
      
      .dh-hand-label { font-size: 9.5px; line-height: 1.3; min-height: 24px; flex: 0 0 auto; color: var(--c-gold); letter-spacing: 1.2px; text-transform: uppercase; font-weight: 600; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px 6px; text-align: center; }
      
      .dh-cards-row { display: flex; gap: 4px 6px; flex-wrap: wrap; justify-content: center; flex: 0 0 74px; height: 74px; width: 100%; align-items: center; align-content: center; min-width: 0; }
      
      /* Enlarged Cards */
      .dh-card {
        width: 52px; height: 74px; background: #fff; border-radius: 5px; border: 1px solid #ccc;
        box-shadow: 0 3px 8px rgba(0,0,0,0.5); display: flex; flex-direction: column; justify-content: space-between; flex: 0 0 auto;
        padding: 3px 4px; font-family: 'Poppins', sans-serif; position: relative; transition: transform 0.2s, box-shadow 0.2s;
      }
      .dh-card:hover { transform: translateY(-4px); box-shadow: 0 6px 12px rgba(0,0,0,0.7); }
      .dh-card.back {
        background: linear-gradient(135deg, #1e272e 0%, #0f1418 100%); border: 1px solid var(--c-gold);
        display: flex; align-items: center; justify-content: center;
      }
      .dh-card.back::after { content: '🐉'; font-size: 22px; opacity: 0.8; }
      
      /* Compact Tile Cards */
      .dh-card.compact {
        width: 34px; height: 34px; padding: 2px 4px; display: flex; flex-direction: row;
        align-items: center; justify-content: center; border-radius: 4px; border: 1px solid #ccc;
        box-shadow: 0 2px 4px rgba(0,0,0,0.4);
      }
      .dh-card.compact .dh-compact-content {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; line-height: 1; font-size: 11px; font-weight: 700; white-space: nowrap;
      }
      .dh-card.compact.back::after { font-size: 16px; }
  
      .dh-card-top { font-size: 10px; font-weight: 700; line-height: 1; display: flex; justify-content: flex-start; white-space: nowrap; }
      .dh-card-center { font-size: 18px; text-align: center; line-height: 1; margin: auto 0; }
      
      .dh-card-bottom { font-size: 10px; font-weight: 700; line-height: 1; align-self: flex-end; white-space: nowrap; transform: rotate(180deg); }
  
      /* Suit & Joker Themes */
      .dh-card.autumn { color: #d35400; border-color: #e67e22; }
      .dh-card.winter { color: #2980b9; border-color: #3498db; }
      .dh-card.spring { color: #27ae60; border-color: #2ecc71; }
      .dh-card.summer { color: #c0392b; border-color: #e74c3c; }
      .dh-card.joker { color: #8e44ad; border-color: #9b59b6; background: #fbf5ff; }
  
      .dh-status-bar { text-align: center; font-size: 11px; font-weight: 600; color: var(--c-white); letter-spacing: 1px; text-transform: uppercase; margin: 0; line-height: 1.4; flex: 0 0 auto; }

      /* Odds Pills */
      .dh-odds-pill {
        font-size: 9px; font-weight: 700; padding: 1px 7px; border-radius: 9px; white-space: nowrap; border: 1px solid; line-height: 1.5;
      }
      .dh-odds-pill.dealer { color: var(--c-white); background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.18); }
      .dh-odds-pill.bust { color: var(--c-red); background: rgba(231, 76, 60, 0.15); border-color: rgba(231, 76, 60, 0.4); }
      .dh-odds-pill.stand { color: var(--c-green); background: rgba(46, 204, 113, 0.15); border-color: rgba(46, 204, 113, 0.4); }
      
      .dh-odds-slot { display: flex; flex: 0 0 40px; min-height: 40px; flex-wrap: wrap; gap: 4px; justify-content: center; align-items: flex-start; align-content: flex-start; width: 100%; }

      /* Other Players At The Table */
      .dh-other-players-row {
        display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; align-items: center;
        padding: 0; flex: 0 0 auto; min-height: 20px; width: 100%; 
      }
      .dh-op-pill {
        font-size: 9px; font-weight: 600; padding: 2px 7px; border-radius: 10px; display: flex; align-items: center; gap: 4px;
        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: var(--c-gray); white-space: nowrap;
      }
      .dh-op-pill .dh-op-name { max-width: 78px; overflow: hidden; text-overflow: ellipsis; }
      .dh-op-pill.stood { color: var(--c-white); border-color: rgba(255,255,255,0.3); }
      .dh-op-pill.bust { color: #ff9d8e; background: rgba(231, 76, 60, 0.14); border-color: rgba(231, 76, 60, 0.45); }
      .dh-op-pill.win { color: #86ffc2; background: rgba(46, 204, 113, 0.14); border-color: rgba(46, 204, 113, 0.45); }
  
      .dh-joker-tag {
        font-size: 8.5px; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; margin-left: 4px; display: inline-flex; align-items: center; gap: 3px;
      }
      .dh-joker-tag.wanderer { background: rgba(230, 126, 34, 0.25); border: 1px solid #e67e22; color: #f39c12; }
      .dh-joker-tag.chronicler { background: rgba(155, 89, 182, 0.25); border: 1px solid #9b59b6; color: #be90d4; }

      /* Dynamic Height Scaling */
      @supports (height: 1cqh) {
        .dh-felt-table { container-type: size; }
        .dh-sides-wrapper {
          --dh-slot-h: 40px;
          --dh-card-h: clamp(52px, calc(100cqh - 102px - var(--dh-slot-h)), 74px);
        }
        .dh-card { width: calc(var(--dh-card-h) * 0.7); height: var(--dh-card-h); }
        .dh-cards-row { flex-basis: var(--dh-card-h); height: var(--dh-card-h); }
        .dh-card.compact {
          width: clamp(26px, calc((var(--dh-card-h) - 4px) / 2), 34px);
          height: clamp(26px, calc((var(--dh-card-h) - 4px) / 2), 34px);
          padding: 0 2px;
        }
        .dh-card.compact .dh-compact-content { font-size: 10px; gap: 1px; }
        .dh-odds-slot { flex: 0 0 var(--dh-slot-h); height: var(--dh-slot-h); min-height: 0; }
        @container (min-width: 820px) { .dh-sides-wrapper { --dh-slot-h: 22px; } }
      }
    `;
    document.head.appendChild(styles);

    let rawPlayerName = (window.playerName) ? window.playerName : 'Player';
    let playerNameCap = rawPlayerName.charAt(0).toUpperCase() + rawPlayerName.slice(1);

    let wheelOrder = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
    let crimsonNums = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

    let getPocketClass = (num) => {
        if (num === 0) return 'r-nuitari';
        return crimsonNums.includes(num) ? 'r-crimson' : 'r-light';
    };

    let generateBoard = () => {
        let boardHtml = `<div class="r-btn r-nuitari" style="grid-row: 1 / span 3; grid-column: 1;" data-bet="0">0</div>`;
        let rows = [
            [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
            [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
            [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]
        ];

        rows.forEach((row, i) => {
            row.forEach((num, colIndex) => {
                boardHtml += `<div class="r-btn ${getPocketClass(num)}" style="grid-row: ${i+1}; grid-column: ${colIndex + 2};" data-bet="${num}">${num}</div>`;
            });
            boardHtml += `<div class="r-btn" style="grid-row: ${i+1}; grid-column: 14; background: rgba(255,255,255,0.08);" data-bet="col${3-i}">2:1</div>`;
        });

        boardHtml += `
        <div class="r-btn r-doz-btn r-doz-start-1" style="grid-row: 4;" data-bet="1st12">1st 12</div>
        <div class="r-btn r-doz-btn r-doz-start-2" style="grid-row: 4;" data-bet="2nd12">2nd 12</div>
        <div class="r-btn r-doz-btn r-doz-start-3" style="grid-row: 4;" data-bet="3rd12">3rd 12</div>
        
        <div class="r-btn r-out-btn r-out-start-1" style="grid-row: 5;" data-bet="low">1-18</div>
        <div class="r-btn r-out-btn r-out-start-2" style="grid-row: 5;" data-bet="even">EVEN</div>
        <div class="r-btn r-out-btn r-out-start-3 crimson" style="grid-row: 5;" data-bet="red">CRIMSON</div>
        <div class="r-btn r-out-btn r-out-start-4 light" style="grid-row: 5;" data-bet="light">LIGHT</div>
        <div class="r-btn r-out-btn r-out-start-5" style="grid-row: 5;" data-bet="odd">ODD</div>
        <div class="r-btn r-out-btn r-out-start-6" style="grid-row: 5;" data-bet="high">19-36</div>
      `;
        return boardHtml;
    };

    let dashboard = document.createElement('div');
    dashboard.id = 'rpg-casino-dashboard';
    dashboard.innerHTML = `
      <div class="palanthas-container">
        <button class="close-dashboard" id="rpg-casino-close" title="Close Dashboard">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
  
        <!-- MAIN MENU -->
        <div id="palanthas-main-menu" style="display: flex; flex-direction: column; align-items: center; width: 100%; height: 100%;">
          <div class="menu-header" style="height: 20px;"></div>
          <h1 class="palanthas-title">PALANTHAS</h1>
          <h2 class="palanthas-subtitle">Gambling Dashboard</h2>
          <div class="palanthas-menu">
            <button class="palanthas-btn" id="btn-open-onjat">Onjat</button>
            <button class="palanthas-btn" id="btn-open-roulette">Wheel of Moons</button>
            <button class="palanthas-btn" id="btn-open-dh">Dragon's Hand</button>
            <button class="palanthas-btn" onclick="console.log('Loading Poker...')">Poker</button>
          </div>
          <div class="data-controls-row">
            <button class="data-btn" id="btn-data-save">Save Data</button>
            <button class="data-btn" id="btn-data-load">Load Data</button>
            <button class="data-btn danger" id="btn-data-clear">Clear Data</button>
          </div>
          <input type="file" id="dh-data-file-input" accept="application/json" style="display: none;">
        </div>
  
        <!-- ONJAT -->
        <div id="onjat-view" class="view-container">
          <div class="oj-header">
            <button class="oj-back-btn" id="oj-back-to-menu">&larr; MENU</button>
            <h1 class="palanthas-title" style="font-size: 18px !important; margin: 0 !important;">ONJAT</h1>
            <div style="width: 65px;"></div>
          </div>
          <div class="oj-arena">
            <div class="oj-arena-status" id="oj-status">WAITING FOR ANTE...</div>
            <div class="oj-drift-display" id="oj-drift-container">
              <span class="oj-drift-label">DRIFT:</span>
              <div class="oj-die drift" id="oj-drift-die">?</div>
            </div>
            <div class="oj-matchup">
              <div class="oj-player-side" id="oj-you-container">
                <div class="oj-drift-label">${playerNameCap}</div>
                <div class="oj-dice-row" id="oj-you-dice"><div class="oj-die">-</div><div class="oj-die">-</div><div class="oj-die">-</div></div>
                <div class="oj-arch-label" id="oj-you-arch">ARCH: --</div>
              </div>
              <div class="oj-player-side" id="oj-house-container">
                <div class="oj-drift-label">HOUSE</div>
                <div class="oj-dice-row" id="oj-house-dice"><div class="oj-die">-</div><div class="oj-die">-</div><div class="oj-die">-</div></div>
                <div class="oj-arch-label" id="oj-house-arch">ARCH: --</div>
              </div>
            </div>
          </div>
  
          <div class="oj-controls">
            <div class="r-chip-selector" id="oj-chips">
              <div class="r-chip r-chip-10" data-chip="10">10</div>
              <div class="r-chip r-chip-50 active" data-chip="50">50</div>
              <div class="r-chip r-chip-100" data-chip="100">100</div>
            </div>
            <div class="oj-stepper-box">
              <button class="oj-step-btn" id="oj-bet-down">-</button>
              <input type="number" id="oj-bet-input" class="oj-bet-input" value="50" step="10" min="10" max="100">
              <button class="oj-step-btn" id="oj-bet-up">+</button>
            </div>
            <span class="unit-tag">PLATINUM</span>
            <button class="oj-action-btn" id="btn-oj-bet">Place Bet</button>
          </div>
  
          <div class="oj-bottom-grid">
            <div class="oj-stats-col">
              <div class="oj-stat-box"><span class="oj-stat-label">Wins</span><span class="oj-stat-val win" id="oj-wins">0</span></div>
              <div class="oj-stat-box"><span class="oj-stat-label">Losses</span><span class="oj-stat-val loss" id="oj-losses">0</span></div>
              <div class="oj-stat-box wide"><span class="oj-stat-label">Win Rate</span><span class="oj-stat-val gold" id="oj-rate">0.0%</span></div>
              <div class="oj-stat-box wide"><span class="oj-stat-label">Net Return</span><span class="oj-stat-val" id="oj-net">0c</span></div>
            </div>
            <div class="oj-chart-col">
              <div class="stat-filter-row overlay" id="oj-stat-filter" data-target="onjat">
                <button class="stat-filter-btn" data-period="1d">1D</button>
                <button class="stat-filter-btn" data-period="1w">1W</button>
                <button class="stat-filter-btn" data-period="1m">1M</button>
                <button class="stat-filter-btn active" data-period="all">ALL</button>
                <button class="stat-filter-btn" data-period="custom" id="oj-cal-btn">📅</button>
              </div>
              <div class="stat-cal-popup" id="oj-cal-popup" style="display: none;">
                <div class="stat-cal-header">
                  <button class="stat-cal-nav" data-dir="-1">‹</button>
                  <span class="stat-cal-month-label" id="oj-cal-month-label"></span>
                  <button class="stat-cal-nav" data-dir="1">›</button>
                </div>
                <div class="stat-cal-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
                <div class="stat-cal-grid" id="oj-cal-grid"></div>
                <div class="stat-cal-footer">
                  <button class="stat-cal-clear" id="oj-cal-clear">Clear</button>
                </div>
              </div>
              <div style="position: relative; width: 100%; height: 100%; padding-top: 24px; box-sizing: border-box;"><canvas id="oj-chart"></canvas></div>
            </div>
          </div>
        </div>
  
        <!-- ROULETTE -->
        <div id="roulette-view" class="view-container">
          <div class="oj-header">
            <button class="oj-back-btn" id="r-back-to-menu">&larr; MENU</button>
            <h1 class="palanthas-title" style="font-size: 18px !important; margin: 0 !important;">WHEEL OF MOONS</h1>
            <div style="width: 65px;"></div>
          </div>
          
          <div class="r-spinner-wrapper">
            <div class="r-spinner-indicator"></div>
            <div class="r-spinner-track" id="r-spinner-track"></div>
          </div>
  
          <div class="r-board" id="r-board">${generateBoard()}</div>
  
          <div class="r-controls">
            <div class="r-chip-selector" id="r-chips">
              <div class="r-chip r-chip-10 active" data-chip="10">10</div>
              <div class="r-chip r-chip-50" data-chip="50">50</div>
              <div class="r-chip r-chip-100" data-chip="100">100</div>
            </div>
  
            <div class="oj-stepper-box">
              <button class="oj-step-btn" id="r-bet-down">-</button>
              <input type="number" id="r-bet-input" class="oj-bet-input" value="10" step="10" min="10" max="100">
              <button class="oj-step-btn" id="r-bet-up">+</button>
            </div>
            <span class="unit-tag">PLATINUM</span>
  
            <button class="r-action-btn" id="btn-r-done">Done Betting</button>
          </div>
  
          <div class="r-summary-panel">
            <div class="r-summary-box">
              <span class="oj-stat-label">STATUS</span>
              <span class="oj-stat-val gold" id="r-status-txt">WAITING FOR BETS</span>
            </div>
            <div class="r-summary-box">
              <span class="oj-stat-label">TOTAL NET RETURN</span>
              <span class="oj-stat-val" id="r-net">0c</span>
            </div>
          </div>
        </div>
  
        <!-- DRAGON'S HAND -->
        <div id="dh-view" class="view-container">
          <div class="oj-header">
            <button class="oj-back-btn" id="dh-back-to-menu">&larr; MENU</button>
            <h1 class="palanthas-title" style="font-size: 18px !important; margin: 0 !important;">DRAGON'S HAND</h1>
            <div style="width: 65px;"></div>
          </div>
  
          <div class="dh-felt-table">
            <div class="dh-status-bar" id="dh-status">PLACE ANTE TO DEAL</div>

            <div class="dh-other-players-row" id="dh-other-players-row"></div>
  
            <div class="dh-sides-wrapper">
              <!-- Dealer Section (Left) -->
              <div class="dh-section">
                <div class="dh-hand-label" id="dh-dealer-label">DEALER'S HAND (TOTAL: 0)</div>
                <div class="dh-cards-row" id="dh-dealer-cards">
                  <div class="dh-card back"></div>
                  <div class="dh-card back"></div>
                </div>
                <div class="dh-odds-slot"><span class="dh-odds-pill dealer" id="dh-odds-dealer"></span></div>
              </div>
  
              <!-- Player Section (Right) -->
              <div class="dh-section">
                <div class="dh-hand-label" id="dh-player-label">${playerNameCap.toUpperCase()}'S HAND (TOTAL: 0)</div>
                <div class="dh-cards-row" id="dh-player-cards">
                  <div class="dh-card back"></div>
                  <div class="dh-card back"></div>
                </div>
                <div class="dh-odds-slot">
                  <span class="dh-odds-pill bust" id="dh-odds-bust"></span>
                  <span class="dh-odds-pill stand" id="dh-odds-stand"></span>
                </div>
              </div>
            </div>
          </div>
  
          <!-- DH ACTION CONTROLS -->
          <div class="dh-controls">
            <div class="r-chip-selector" id="dh-chips">
              <div class="r-chip r-chip-10" data-chip="10">10</div>
              <div class="r-chip r-chip-50 active" data-chip="50">50</div>
              <div class="r-chip r-chip-100" data-chip="100">100</div>
            </div>
  
            <div class="oj-stepper-box">
              <button class="oj-step-btn" id="dh-bet-down">-</button>
              <input type="number" id="dh-bet-input" class="oj-bet-input" value="50" step="10" min="10" max="100">
              <button class="oj-step-btn" id="dh-bet-up">+</button>
            </div>
            <span class="unit-tag">PLATINUM</span>
  
            <button class="dh-action-btn" id="btn-dh-bet">Bet</button>
            <button class="dh-action-btn" id="btn-dh-hit">Hit</button>
            <button class="dh-action-btn" id="btn-dh-stand">Stand</button>
            <button class="dh-action-btn btn-double" id="btn-dh-double">Double</button>
            <button class="dh-action-btn btn-auto" id="btn-dh-auto">Start Auto</button>
          </div>

          <!-- SCRIPT SETTINGS -->
          <div class="dh-auto-modal-overlay" id="dh-auto-modal-overlay" style="display: none;">
            <div class="dh-auto-modal">
              <div class="dh-auto-modal-title">Auto-Play Settings</div>

              <label class="dh-auto-row">
                <input type="checkbox" id="dh-auto-allow-double">
                <span>Allow doubling (EV-based)</span>
              </label>

              <div class="dh-auto-divider"></div>
              <div class="dh-auto-section-label">Stop Conditions</div>

              <label class="dh-auto-row">
                <input type="checkbox" id="dh-auto-stop-hands-en">
                <span>Stop after</span>
                <input type="number" id="dh-auto-stop-hands" class="dh-auto-num" value="50" min="1">
                <span>hands</span>
              </label>

              <label class="dh-auto-row">
                <input type="checkbox" id="dh-auto-stop-profit-en">
                <span>Stop at profit &ge;</span>
                <input type="number" id="dh-auto-stop-profit" class="dh-auto-num" value="200" min="1">
                <span>plat.</span>
              </label>

              <label class="dh-auto-row">
                <input type="checkbox" id="dh-auto-stop-loss-en">
                <span>Stop at loss &ge;</span>
                <input type="number" id="dh-auto-stop-loss" class="dh-auto-num" value="200" min="1">
                <span>plat.</span>
              </label>

              <label class="dh-auto-row">
                <input type="checkbox" id="dh-auto-stop-time-en">
                <span>Stop after</span>
                <input type="number" id="dh-auto-stop-time" class="dh-auto-num" value="30" min="1">
                <span>minutes</span>
              </label>

              <div class="dh-auto-hint">Stops always finish the current hand first — never mid-turn.</div>

              <div class="dh-auto-modal-actions">
                <button class="dh-action-btn" id="dh-auto-cancel">Cancel</button>
                <button class="dh-action-btn btn-auto" id="dh-auto-confirm">Start</button>
              </div>
            </div>
          </div>
  
          <div class="oj-bottom-grid dh-bottom-grid">
            <div class="oj-stats-col">
              <div class="oj-stat-box"><span class="oj-stat-label">Wins</span><span class="oj-stat-val win" id="dh-wins">0</span></div>
              <div class="oj-stat-box"><span class="oj-stat-label">Losses</span><span class="oj-stat-val loss" id="dh-losses">0</span></div>
              <div class="oj-stat-box wide"><span class="oj-stat-label">Win Rate</span><span class="oj-stat-val gold" id="dh-rate">0.0%</span></div>
              <div class="oj-stat-box wide"><span class="oj-stat-label">Net Return</span><span class="oj-stat-val" id="dh-net">0c</span></div>
            </div>
            <div class="oj-chart-col">
              <div class="stat-filter-row overlay" id="dh-stat-filter" data-target="dh">
                <button class="stat-filter-btn" data-period="1d">1D</button>
                <button class="stat-filter-btn" data-period="1w">1W</button>
                <button class="stat-filter-btn" data-period="1m">1M</button>
                <button class="stat-filter-btn active" data-period="all">ALL</button>
                <button class="stat-filter-btn" data-period="custom" id="dh-cal-btn">📅</button>
              </div>
              <div class="stat-cal-popup" id="dh-cal-popup" style="display: none;">
                <div class="stat-cal-header">
                  <button class="stat-cal-nav" data-dir="-1">‹</button>
                  <span class="stat-cal-month-label" id="dh-cal-month-label"></span>
                  <button class="stat-cal-nav" data-dir="1">›</button>
                </div>
                <div class="stat-cal-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
                <div class="stat-cal-grid" id="dh-cal-grid"></div>
                <div class="stat-cal-footer">
                  <button class="stat-cal-clear" id="dh-cal-clear">Clear</button>
                </div>
              </div>
              <div class="stat-filter-row overlay source-row" id="dh-source-filter">
                <button class="stat-filter-btn" data-source="manual">MANUAL</button>
                <button class="stat-filter-btn" data-source="auto">AUTO</button>
                <button class="stat-filter-btn active" data-source="all">ALL</button>
              </div>
              <div class="dh-chart-wrap"><canvas id="dh-chart"></canvas></div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(dashboard);

    // Onjat & Roulette Stepper & Chip Controls
    let ojBetInput = document.getElementById('oj-bet-input');
    let syncOjChips = (val) => {
        document.querySelectorAll('#oj-chips .r-chip').forEach(c => c.classList.toggle('active', parseInt(c.getAttribute('data-chip'), 10) === val));
    };
    let updateOjBet = (delta) => {
        let newVal = Math.min(CASINO_BET_CAP, Math.max(10, (parseInt(ojBetInput.value, 10) || 0) + delta));
        ojBetInput.value = newVal;
        syncOjChips(newVal);
    };
    document.getElementById('oj-bet-up').addEventListener('click', () => updateOjBet(10));
    document.getElementById('oj-bet-down').addEventListener('click', () => updateOjBet(-10));
    ojBetInput.addEventListener('input', () => {
        let val = Math.min(CASINO_BET_CAP, Math.max(0, parseInt(ojBetInput.value, 10) || 0));
        if (parseInt(ojBetInput.value, 10) !== val) ojBetInput.value = val;
        syncOjChips(val);
    });
    ojBetInput.addEventListener('wheel', (e) => {
        e.preventDefault();
        updateOjBet(e.deltaY < 0 ? 10 : -10);
    });
    document.getElementById('oj-chips').addEventListener('click', (e) => {
        if (e.target.classList.contains('r-chip')) {
            let val = parseInt(e.target.getAttribute('data-chip'), 10);
            ojBetInput.value = val;
            syncOjChips(val);
            sendCommand(`bet ${val} platinum`);
        }
    });
    document.getElementById('btn-oj-bet').addEventListener('click', () => {
        sendCommand(`bet ${parseInt(ojBetInput.value, 10) || 50} platinum`);
    });

    let rBetInput = document.getElementById('r-bet-input');
    let syncRChips = (val) => {
        document.querySelectorAll('#r-chips .r-chip').forEach(c => c.classList.toggle('active', parseInt(c.getAttribute('data-chip'), 10) === val));
    };
    let updateRBet = (delta) => {
        let newVal = Math.min(CASINO_BET_CAP, Math.max(10, (parseInt(rBetInput.value, 10) || 0) + delta));
        rBetInput.value = newVal;
        syncRChips(newVal);
    };
    document.getElementById('r-bet-up').addEventListener('click', () => updateRBet(10));
    document.getElementById('r-bet-down').addEventListener('click', () => updateRBet(-10));
    rBetInput.addEventListener('input', () => {
        let val = Math.min(CASINO_BET_CAP, Math.max(0, parseInt(rBetInput.value, 10) || 0));
        if (parseInt(rBetInput.value, 10) !== val) rBetInput.value = val;
        syncRChips(val);
    });
    rBetInput.addEventListener('wheel', (e) => {
        e.preventDefault();
        updateRBet(e.deltaY < 0 ? 10 : -10);
    });
    document.getElementById('r-chips').addEventListener('click', (e) => {
        if (e.target.classList.contains('r-chip')) {
            let val = parseInt(e.target.getAttribute('data-chip'), 10);
            rBetInput.value = val;
            syncRChips(val);
        }
    });

    // Dragon's Hand Card Parser & Bust Calculator
    let dhBetInput = document.getElementById('dh-bet-input');
    let syncDhChips = (val) => {
        document.querySelectorAll('#dh-chips .r-chip').forEach(c => c.classList.toggle('active', parseInt(c.getAttribute('data-chip'), 10) === val));
    };
    let updateDhBet = (delta) => {
        let newVal = Math.min(CASINO_BET_CAP, Math.max(10, (parseInt(dhBetInput.value, 10) || 0) + delta));
        dhBetInput.value = newVal;
        syncDhChips(newVal);
    };
    document.getElementById('dh-bet-up').addEventListener('click', () => updateDhBet(10));
    document.getElementById('dh-bet-down').addEventListener('click', () => updateDhBet(-10));
    dhBetInput.addEventListener('input', () => {
        let val = Math.min(CASINO_BET_CAP, Math.max(0, parseInt(dhBetInput.value, 10) || 0));
        if (parseInt(dhBetInput.value, 10) !== val) dhBetInput.value = val;
        syncDhChips(val);
    });
    dhBetInput.addEventListener('wheel', (e) => {
        e.preventDefault();
        updateDhBet(e.deltaY < 0 ? 10 : -10);
    });
    document.getElementById('dh-chips').addEventListener('click', (e) => {
        if (e.target.classList.contains('r-chip')) {
            let val = parseInt(e.target.getAttribute('data-chip'), 10);
            dhBetInput.value = val;
            syncDhChips(val);
        }
    });

    document.getElementById('btn-dh-bet').addEventListener('click', () => sendCommand(`bet ${parseInt(dhBetInput.value, 10) || 50} platinum`));
    document.getElementById('btn-dh-hit').addEventListener('click', () => sendCommand('hit'));
    document.getElementById('btn-dh-stand').addEventListener('click', () => sendCommand('stand'));
    document.getElementById('btn-dh-double').addEventListener('click', () => sendCommand('double'));

    // Script Settings & Controls
    let dhAutoModalOverlay = document.getElementById('dh-auto-modal-overlay');
    let btnDhAuto = document.getElementById('btn-dh-auto');

    let openDhAutoModal = () => {
        document.getElementById('dh-auto-allow-double').checked = dhAutoParams.allowDouble;
        document.getElementById('dh-auto-stop-hands-en').checked = dhAutoParams.stopHandsEnabled;
        document.getElementById('dh-auto-stop-hands').value = dhAutoParams.stopHands;
        document.getElementById('dh-auto-stop-profit-en').checked = dhAutoParams.stopProfitEnabled;
        document.getElementById('dh-auto-stop-profit').value = dhAutoParams.stopProfit;
        document.getElementById('dh-auto-stop-loss-en').checked = dhAutoParams.stopLossEnabled;
        document.getElementById('dh-auto-stop-loss').value = dhAutoParams.stopLoss;
        document.getElementById('dh-auto-stop-time-en').checked = dhAutoParams.stopMinutesEnabled;
        document.getElementById('dh-auto-stop-time').value = dhAutoParams.stopMinutes;
        dhAutoModalOverlay.style.display = 'flex';
    };
    let closeDhAutoModal = () => {
        dhAutoModalOverlay.style.display = 'none';
    };
    let setDhAutoButtonState = (running) => {
        btnDhAuto.innerText = running ? 'Stop Auto' : 'Start Auto';
        btnDhAuto.classList.toggle('running', running);
    };

    btnDhAuto.addEventListener('click', () => {
        if (dhAutoActive) {
            dhAutoStopRequested = true;
            btnDhAuto.innerText = 'Stopping…';
        } else {
            openDhAutoModal();
        }
    });

    document.getElementById('dh-auto-cancel').addEventListener('click', () => closeDhAutoModal());

    document.getElementById('dh-auto-confirm').addEventListener('click', () => {
        dhAutoParams.allowDouble = document.getElementById('dh-auto-allow-double').checked;
        dhAutoParams.stopHandsEnabled = document.getElementById('dh-auto-stop-hands-en').checked;
        dhAutoParams.stopHands = Math.max(1, parseInt(document.getElementById('dh-auto-stop-hands').value, 10) || 1);
        dhAutoParams.stopProfitEnabled = document.getElementById('dh-auto-stop-profit-en').checked;
        dhAutoParams.stopProfit = Math.max(1, parseInt(document.getElementById('dh-auto-stop-profit').value, 10) || 1);
        dhAutoParams.stopLossEnabled = document.getElementById('dh-auto-stop-loss-en').checked;
        dhAutoParams.stopLoss = Math.max(1, parseInt(document.getElementById('dh-auto-stop-loss').value, 10) || 1);
        dhAutoParams.stopMinutesEnabled = document.getElementById('dh-auto-stop-time-en').checked;
        dhAutoParams.stopMinutes = Math.max(1, parseInt(document.getElementById('dh-auto-stop-time').value, 10) || 1);

        closeDhAutoModal();

        dhAutoActive = true;
        dhAutoStopRequested = false;
        dhAutoHandsPlayed = 0;
        dhAutoStartTime = Date.now();
        dhAutoStartNetCopper = dhState.netCopper;
        dhAutoIsFirstMove = true;
        dhAutoLastActedSig = '';
        dhAutoLastActedAt = 0;
        dhAutoAwaitingTurn = false;
        dhAutoDoubleOffered = false;
        dhAutoLastAction = '';
        if (dhAutoTurnTimer) {
            clearTimeout(dhAutoTurnTimer);
            dhAutoTurnTimer = null;
        }
        setDhAutoButtonState(true);

        if (!dhRoundActive) {
            sendCommand(`bet ${parseInt(dhBetInput.value, 10) || 50} platinum`);
        }
    });

    let checkDhAutoStopConditions = () => {
        if (dhAutoParams.stopHandsEnabled && dhAutoHandsPlayed >= dhAutoParams.stopHands) return true;
        let netPlat = (dhState.netCopper - dhAutoStartNetCopper) / P_MULTIPLIER;
        if (dhAutoParams.stopProfitEnabled && netPlat >= dhAutoParams.stopProfit) return true;
        if (dhAutoParams.stopLossEnabled && netPlat <= -dhAutoParams.stopLoss) return true;
        if (dhAutoParams.stopMinutesEnabled && (Date.now() - dhAutoStartTime) >= dhAutoParams.stopMinutes * 60000) return true;
        return false;
    };

    let dhAutoRandomDelay = () => DH_AUTO_DELAY_MIN_MS + Math.random() * (DH_AUTO_DELAY_MAX_MS - DH_AUTO_DELAY_MIN_MS);

    let dhAutoHalt = () => {
        dhAutoActive = false;
        dhAutoStopRequested = false;
        dhAutoAwaitingTurn = false;
        if (dhAutoTurnTimer) {
            clearTimeout(dhAutoTurnTimer);
            dhAutoTurnTimer = null;
        }
        setDhAutoButtonState(false);
    };

    let dhAutoAdvanceOrStop = () => {
        if (!dhAutoActive) return;
        dhAutoAwaitingTurn = false;
        if (dhAutoTurnTimer) {
            clearTimeout(dhAutoTurnTimer);
            dhAutoTurnTimer = null;
        }
        if (dhAutoStopRequested || checkDhAutoStopConditions()) {
            dhAutoHalt();
            return;
        }
        sendCommand(`bet ${parseInt(dhBetInput.value, 10) || 50} platinum`);
    };

    let FULL_KRYNN_DECK = [];
    let SUITS = ['Autumn', 'Winter', 'Spring', 'Summer'];
    let RANKS = [{
            raw: 'Two',
            num: 2
        }, {
            raw: 'Three',
            num: 3
        }, {
            raw: 'Four',
            num: 4
        },
        {
            raw: 'Five',
            num: 5
        }, {
            raw: 'Six',
            num: 6
        }, {
            raw: 'Seven',
            num: 7
        },
        {
            raw: 'Eight',
            num: 8
        }, {
            raw: 'Nine',
            num: 9
        }, {
            raw: 'Ten',
            num: 10
        },
        {
            raw: 'Knight',
            num: 10
        }, {
            raw: 'Lady',
            num: 10
        }, {
            raw: 'Highlord',
            num: 10
        },
        {
            raw: 'Dragon',
            num: 'ACE'
        }
    ];
    SUITS.forEach(s => {
        RANKS.forEach(r => {
            FULL_KRYNN_DECK.push(`${s} ${r.raw}`);
        });
    });
    FULL_KRYNN_DECK.push("The Wanderer");
    FULL_KRYNN_DECK.push("The Chronicler");
    FULL_KRYNN_DECK.push("The Fool");

    let parseCardString = (cardStr) => {
        if (!cardStr) return {
            raw: '',
            suit: 'joker',
            icon: '❓',
            label: '?'
        };
        let cleanStr = cardStr.trim().replace(/^(a|an|the)\s+/i, '');
        let suit = 'joker';
        let icon = '🃏';
        let label = cleanStr;

        if (cleanStr.includes('Autumn')) {
            suit = 'autumn';
            icon = '🍂';
        } else if (cleanStr.includes('Winter')) {
            suit = 'winter';
            icon = '❄️';
        } else if (cleanStr.includes('Spring')) {
            suit = 'spring';
            icon = '🌱';
        } else if (cleanStr.includes('Summer')) {
            suit = 'summer';
            icon = '🔥';
        }

        if (/Dragon/i.test(cleanStr)) label = 'ACE';
        else if (/Highlord/i.test(cleanStr)) label = 'KING';
        else if (/Lady/i.test(cleanStr)) label = 'QUEEN';
        else if (/Knight/i.test(cleanStr)) label = 'JACK';
        else if (/Fool/i.test(cleanStr)) {
            label = 'FOOL';
            icon = '🧙‍';
            suit = 'joker';
        } else if (/Wanderer/i.test(cleanStr)) {
            label = 'KENDER';
            icon = '🎒';
            suit = 'joker';
        } else if (/Chronicler/i.test(cleanStr)) {
            label = 'ASTINUS';
            icon = '📜';
            suit = 'joker';
        } else {
            let numMatch = cleanStr.match(/(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)/i);
            if (numMatch) {
                let wordMap = {
                    'two': '2',
                    'three': '3',
                    'four': '4',
                    'five': '5',
                    'six': '6',
                    'seven': '7',
                    'eight': '8',
                    'nine': '9',
                    'ten': '10'
                };
                label = wordMap[numMatch[1].toLowerCase()] || numMatch[1];
            }
        }

        return {
            raw: cardStr,
            suit,
            icon,
            label
        };
    };

    let evaluateKrynnHand = (handStrArray) => {
        let parsedCards = handStrArray.map(parseCardString);
        let hasWanderer = parsedCards.some(c => c.label === 'KENDER');
        let hasChronicler = parsedCards.some(c => c.label === 'ASTINUS');

        let total = 0;
        let flexAces = 0;

        parsedCards.forEach(c => {
            if (c.label === 'ACE' || c.label === 'FOOL') {
                flexAces++;
            } else if (c.label === 'KENDER' || c.label === 'ASTINUS') {
                total += 0;
            } else {
                let rawVal = 10;
                if (c.label.match(/^\d+$/)) {
                    rawVal = parseInt(c.label, 10);
                }
                let effectiveVal = hasWanderer ? (11 - rawVal) : rawVal;
                total += effectiveVal;
            }
        });

        total += flexAces;
        let isSoft = false;
        for (let i = 0; i < flexAces; i++) {
            if (total + 10 <= 21) {
                total += 10;
                isSoft = true;
            }
        }

        return {
            total,
            isSoft,
            hasWanderer,
            hasChronicler
        };
    };

    let DH_SHORT_LABELS = {
        ACE: 'A',
        KING: 'K',
        QUEEN: 'Q',
        JACK: 'J',
        FOOL: 'FOL',
        KENDER: 'KEN',
        ASTINUS: 'AST'
    };

    let renderCardHTML = (cardObj, isWandererActive = false, isCompact = false) => {
        if (!cardObj) return `<div class="dh-card back${isCompact ? ' compact' : ''}"></div>`;

        let displayLabel = cardObj.label;
        let isOrdinary = !['ACE', 'FOOL', 'KENDER', 'ASTINUS'].includes(cardObj.label);

        if (isWandererActive && isOrdinary) {
            let rawVal = 10;
            if (cardObj.label.match(/^\d+$/)) rawVal = parseInt(cardObj.label, 10);
            let invertedVal = 11 - rawVal;
            displayLabel = `${cardObj.label}➔${invertedVal}`;
        }

        if (isCompact) {
            let shortLabel = DH_SHORT_LABELS[cardObj.label] || cardObj.label;
            if (isWandererActive && isOrdinary) {
                let rawVal = 10;
                if (cardObj.label.match(/^\d+$/)) rawVal = parseInt(cardObj.label, 10);
                let invertedVal = 11 - rawVal;
                shortLabel = `${shortLabel}➔${invertedVal}`;
            }

            return `
          <div class="dh-card compact ${cardObj.suit}">
            <div class="dh-compact-content">
              <span>${shortLabel}</span><span>${cardObj.icon}</span>
            </div>
          </div>
        `;
        }

        let fontStyle = displayLabel.length > 6 ? 'font-size: 6.5px; letter-spacing: -0.2px;' :
            displayLabel.length > 3 ? 'font-size: 8px;' : '';

        return `
        <div class="dh-card ${cardObj.suit}">
          <div class="dh-card-top"><span style="${fontStyle}">${displayLabel}</span></div>
          <div class="dh-card-center">${cardObj.icon}</div>
          <div class="dh-card-bottom"><span style="${fontStyle}">${displayLabel}</span></div>
        </div>
      `;
    };

    let calculateExactBustProbability = (playerHandArray, knownOtherCards = []) => {
        if (playerHandArray.length === 0) return 0.0;

        let s = dhStateFromCards(playerHandArray);
        if (dhStateTotal(s) >= 21) return 100.0;

        let counts = dhCountsExcluding([...playerHandArray, ...knownOtherCards]);
        let N = counts.reduce((a, b) => a + b, 0);
        if (N === 0) return 0.0;

        let bustCards = 0;
        for (let k = 0; k < DH_NUM_CLASSES; k++) {
            if (counts[k] > 0 && dhStateTotal(dhAddClass(s, k)) > 21) bustCards += counts[k];
        }
        return ((bustCards / N) * 100).toFixed(1);
    };

    // Card-Class Math Engine
    let DH_CLASS_FLEX = 9,
        DH_CLASS_KENDER = 10,
        DH_CLASS_ASTINUS = 11,
        DH_NUM_CLASSES = 12;

    let dhClassOfCard = (cardStr) => {
        let label = parseCardString(cardStr).label;
        if (label === 'ACE' || label === 'FOOL') return DH_CLASS_FLEX;
        if (label === 'KENDER') return DH_CLASS_KENDER;
        if (label === 'ASTINUS') return DH_CLASS_ASTINUS;
        let raw = /^\d+$/.test(label) ? parseInt(label, 10) : 10;
        return Math.min(10, Math.max(2, raw)) - 2;
    };

    let DH_FULL_COUNTS = (() => {
        let c = new Array(DH_NUM_CLASSES).fill(0);
        FULL_KRYNN_DECK.forEach(card => {
            c[dhClassOfCard(card)]++;
        });
        return c;
    })();

    let dhCountsExcluding = (knownCards) => {
        let counts = DH_FULL_COUNTS.slice();
        knownCards.forEach(c => {
            let k = dhClassOfCard(c);
            if (counts[k] > 0) counts[k]--;
        });
        return counts;
    };

    let dhStateFromCards = (cards) => {
        let sum = 0,
            n = 0,
            aces = 0,
            w = 0;
        cards.forEach(c => {
            let k = dhClassOfCard(c);
            if (k <= 8) {
                sum += k + 2;
                n++;
            } else if (k === DH_CLASS_FLEX) aces++;
            else if (k === DH_CLASS_KENDER) w = 1;
        });
        return {
            sum,
            n,
            aces,
            w
        };
    };

    let dhAddClass = (s, k) => {
        if (k <= 8) return {
            sum: s.sum + k + 2,
            n: s.n + 1,
            aces: s.aces,
            w: s.w
        };
        if (k === DH_CLASS_FLEX) return {
            sum: s.sum,
            n: s.n,
            aces: s.aces + 1,
            w: s.w
        };
        if (k === DH_CLASS_KENDER) return {
            sum: s.sum,
            n: s.n,
            aces: s.aces,
            w: 1
        };
        return s;
    };

    let dhStateTotal = (s) => {
        let total = s.w ? 11 * s.n - s.sum : s.sum;
        total += s.aces;
        for (let i = 0; i < s.aces; i++) {
            if (total + 10 <= 21) total += 10;
        }
        return total;
    };
    let dhStateKey = (s) => ((s.sum * 32 + s.n) * 8 + s.aces) * 2 + s.w;

    let dhWork = 0,
        dhWorkLimit = 2000000;
    let dhTick = () => {
        if (++dhWork > dhWorkLimit) throw new Error('DH_WORK_BUDGET');
    };

    let dhDealerDistCache = new Map();
    let dhFrozenCache = new Map();
    let dhEvCache = new Map();

    let DH_DIST_BUST = [1, 0, 0, 0, 0, 0];
    let DH_DIST_AT = {
        17: [0, 1, 0, 0, 0, 0],
        18: [0, 0, 1, 0, 0, 0],
        19: [0, 0, 0, 1, 0, 0],
        20: [0, 0, 0, 0, 1, 0],
        21: [0, 0, 0, 0, 0, 1]
    };
    let DH_DIST_NONE = [0, 0, 0, 0, 0, 0];

    let dhDealerDist = (s, counts, N) => {
        let total = dhStateTotal(s);
        if (total > 21) return DH_DIST_BUST;
        if (total >= 17) return DH_DIST_AT[total];
        if (N <= 0) return DH_DIST_NONE;
        let key = dhStateKey(s) + '|' + counts.join(',');
        let hit = dhDealerDistCache.get(key);
        if (hit) return hit;
        dhTick();
        let out = [0, 0, 0, 0, 0, 0];
        for (let k = 0; k < DH_NUM_CLASSES; k++) {
            let c = counts[k];
            if (c === 0) continue;
            let p = c / N;
            counts[k] = c - 1;
            let sub = dhDealerDist(dhAddClass(s, k), counts, N - 1);
            counts[k] = c;
            out[0] += sub[0] * p;
            out[1] += sub[1] * p;
            out[2] += sub[2] * p;
            out[3] += sub[3] * p;
            out[4] += sub[4] * p;
            out[5] += sub[5] * p;
        }
        dhDealerDistCache.set(key, out);
        return out;
    };

    let dhDealerDistWithHole = (upState, counts, N, holeUnknown) => {
        if (!holeUnknown) return dhDealerDist(upState, counts, N);
        let out = [0, 0, 0, 0, 0, 0];
        for (let k = 0; k < DH_NUM_CLASSES; k++) {
            let c = counts[k];
            if (c === 0) continue;
            let p = c / N;
            counts[k] = c - 1;
            let sub = dhDealerDist(dhAddClass(upState, k), counts, N - 1);
            counts[k] = c;
            out[0] += sub[0] * p;
            out[1] += sub[1] * p;
            out[2] += sub[2] * p;
            out[3] += sub[3] * p;
            out[4] += sub[4] * p;
            out[5] += sub[5] * p;
        }
        return out;
    };

    let dhBuildContext = (dealerHandArray, holeCardHidden, otherKnownCards) => {
        let holeUnknown = holeCardHidden || dealerHandArray.length < 2;
        let dealerKnown = holeUnknown ? dealerHandArray.slice(0, 1) : dealerHandArray;
        let counts = dhCountsExcluding([...otherKnownCards, ...dealerKnown]);
        let N = counts.reduce((a, b) => a + b, 0);
        let dealerState = dhStateFromCards(dealerKnown);
        return {
            holeUnknown,
            counts,
            N,
            dealerState,
            sig: dhStateKey(dealerState) + (holeUnknown ? 'h' : 'k')
        };
    };

    let getOtherPlayersKnownCards = () => {
        return Object.values(dhOtherPlayers).flatMap(p => p.hand || []);
    };

    let calculateDealerOutcomeDistribution = (dealerHandArray, playerHandArray = [], holeCardHidden = true) => {
        let ctx = dhBuildContext(dealerHandArray, holeCardHidden, playerHandArray);
        dhWork = 0;
        dhWorkLimit = 2000000;
        let f = dhDealerDistWithHole(ctx.dealerState, ctx.counts, ctx.N, ctx.holeUnknown);
        let pct = v => +(v * 100).toFixed(1);
        return {
            bust: pct(f[0]),
            17: pct(f[1]),
            18: pct(f[2]),
            19: pct(f[3]),
            20: pct(f[4]),
            21: pct(f[5])
        };
    };

    let calculateStandOdds = (playerTotal, dealerHandArray, playerHandArray, holeCardHidden) => {
        let dist = calculateDealerOutcomeDistribution(dealerHandArray, playerHandArray, holeCardHidden);
        let win = dist.bust,
            push = 0,
            lose = 0;

        [17, 18, 19, 20, 21].forEach(v => {
            if (playerTotal > v) win += dist[v];
            else if (playerTotal === v) push += dist[v];
            else lose += dist[v];
        });

        return {
            win: +win.toFixed(1),
            push: +push.toFixed(1),
            lose: +lose.toFixed(1),
            dealerDistribution: dist
        };
    };

    // Script EV Engine
    let DH_EXACT_DEPTH = 1;

    let dhStandEV = (t, dist) => {
        if (t > 21) return -1;
        let ev = dist[0];
        for (let i = 0; i < 5; i++) {
            let v = 17 + i;
            if (t > v) ev += dist[i + 1];
            else if (t < v) ev -= dist[i + 1];
        }
        return ev;
    };

    let dhFrozenHit = (s, counts, dist, countsKey) => {
        let wsum = 0,
            acc = 0;
        for (let k = 0; k < DH_NUM_CLASSES; k++) {
            let c = counts[k];
            if (c === 0) continue;
            if (k === DH_CLASS_ASTINUS || (k === DH_CLASS_KENDER && s.w === 1)) continue;
            let child = dhAddClass(s, k);
            let ct = dhStateTotal(child);
            wsum += c;
            acc += c * (ct > 21 ? -1 : dhFrozenBest(child, counts, dist, countsKey));
        }
        return wsum > 0 ? acc / wsum : -Infinity;
    };

    let dhFrozenBest = (s, counts, dist, countsKey) => {
        let t = dhStateTotal(s);
        if (t > 21) return -1;
        let key = countsKey + '#' + dhStateKey(s);
        let cached = dhFrozenCache.get(key);
        if (cached !== undefined) return cached;
        dhTick();
        let standEV = dhStandEV(t, dist);
        let hitEV = dhFrozenHit(s, counts, dist, countsKey);
        let best = hitEV > standEV ? hitEV : standEV;
        dhFrozenCache.set(key, best);
        return best;
    };

    let dhBestNode = (ctx, s, counts, N, depthLeft) => {
        let t = dhStateTotal(s);
        if (t > 21) return {
            ev: -1,
            action: 'stand',
            hitEV: -1,
            standEV: -1
        };
        let countsKey = counts.join(',');
        let key = dhStateKey(s) + '|' + countsKey + '|' + depthLeft + '|' + ctx.sig;
        let cached = dhEvCache.get(key);
        if (cached) return cached;
        dhTick();

        let dist = dhDealerDistWithHole(ctx.dealerState, counts, N, ctx.holeUnknown);
        let standEV = dhStandEV(t, dist);

        let hitEV = -Infinity;
        if (N > 0) {
            if (depthLeft <= 0) {
                hitEV = dhFrozenHit(s, counts, dist, countsKey);
            } else {
                hitEV = 0;
                for (let k = 0; k < DH_NUM_CLASSES; k++) {
                    let c = counts[k];
                    if (c === 0) continue;
                    let child = dhAddClass(s, k);
                    let v;
                    if (dhStateTotal(child) > 21) {
                        v = -1;
                    } else {
                        counts[k] = c - 1;
                        v = dhBestNode(ctx, child, counts, N - 1, depthLeft - 1).ev;
                        counts[k] = c;
                    }
                    hitEV += (c / N) * v;
                }
            }
        }

        let result = {
            ev: Math.max(hitEV, standEV),
            action: hitEV > standEV ? 'hit' : 'stand',
            hitEV,
            standEV
        };
        dhEvCache.set(key, result);
        return result;
    };

    let dhDoubleEV = (ctx, s, counts, N) => {
        if (N <= 0) return -Infinity;
        let ev = 0;
        for (let k = 0; k < DH_NUM_CLASSES; k++) {
            let c = counts[k];
            if (c === 0) continue;
            let child = dhAddClass(s, k);
            let ct = dhStateTotal(child);
            let v;
            if (ct > 21) {
                v = -1;
            } else {
                counts[k] = c - 1;
                v = dhStandEV(ct, dhDealerDistWithHole(ctx.dealerState, counts, N - 1, ctx.holeUnknown));
                counts[k] = c;
            }
            ev += (c / N) * v;
        }
        return 2 * ev;
    };

    let decideDhAction = (allowDouble, isFirstMove) => {
        let ctx = dhBuildContext(dhDealerHand, dhDealerHoleCardHidden, [...dhPlayerHand, ...getOtherPlayersKnownCards()]);
        let s = dhStateFromCards(dhPlayerHand);
        dhWork = 0;
        dhWorkLimit = 1500000;

        let best = dhBestNode(ctx, s, ctx.counts, ctx.N, DH_EXACT_DEPTH);
        let action = best.action,
            ev = best.ev;

        if (allowDouble && isFirstMove) {
            let d = dhDoubleEV(ctx, s, ctx.counts, ctx.N);
            if (d > ev) {
                action = 'double';
                ev = d;
            }
        }
        return {
            action,
            ev,
            hitEV: best.hitEV,
            standEV: best.standEV
        };
    };

    let updateDhUI = () => {
        let pContainer = document.getElementById('dh-player-cards');
        let dContainer = document.getElementById('dh-dealer-cards');

        let playerEval = evaluateKrynnHand(dhPlayerHand);

        let fullDealerEval = evaluateKrynnHand(dhDealerHand);
        let visibleDealerCards = (dhDealerHoleCardHidden && dhDealerHand.length > 0) ? dhDealerHand.slice(0, 1) : dhDealerHand;
        let visibleDealerEval = evaluateKrynnHand(visibleDealerCards);

        if (playerEval.hasChronicler || fullDealerEval.hasChronicler) {
            dhDealerHoleCardHidden = false;
        }

        let isPlayerCompact = dhPlayerHand.length > 5;
        let isDealerCompact = dhDealerHand.length > 5;

        if (dhPlayerHand.length > 0) {
            pContainer.innerHTML = dhPlayerHand.map(c => renderCardHTML(parseCardString(c), playerEval.hasWanderer, isPlayerCompact)).join('');
        } else {
            pContainer.innerHTML = `<div class="dh-card back"></div><div class="dh-card back"></div>`;
        }

        if (dhDealerHand.length > 0) {
            let html = '';
            if (dhDealerHoleCardHidden) {
                html = renderCardHTML(parseCardString(dhDealerHand[0]), visibleDealerEval.hasWanderer, isDealerCompact) + `<div class="dh-card back${isDealerCompact ? ' compact' : ''}"></div>`;
            } else {
                html = dhDealerHand.map(c => renderCardHTML(parseCardString(c), fullDealerEval.hasWanderer, isDealerCompact)).join('');
            }
            dContainer.innerHTML = html;
        } else {
            dContainer.innerHTML = `<div class="dh-card back"></div><div class="dh-card back"></div>`;
        }

        dhPlayerTotal = playerEval.total;
        dhIsSoft = playerEval.isSoft;

        let dLabel = document.getElementById('dh-dealer-label');
        let dJokerTag = '';
        if (playerEval.hasChronicler || fullDealerEval.hasChronicler) {
            dJokerTag = `<span class="dh-joker-tag chronicler">📜 ASTINUS REVEAL</span>`;
        }

        let dealerTotalDisplay = '0';
        if (dhDealerHand.length > 0) {
            if (dhDealerHoleCardHidden) {
                dealerTotalDisplay = `${visibleDealerEval.total} + ?`;
            } else {
                dealerTotalDisplay = `${fullDealerEval.total}${fullDealerEval.isSoft ? ', SOFT' : ''}`;
            }
        }
        dLabel.innerHTML = `DEALER'S HAND (TOTAL: ${dealerTotalDisplay}) ${dJokerTag}`;

        let pLabel = document.getElementById('dh-player-label');
        let pJokerTag = playerEval.hasWanderer ? `<span class="dh-joker-tag wanderer">🎒 WANDERER ACTIVE</span>` : '';
        pLabel.innerHTML = `${playerNameCap.toUpperCase()}'S HAND (TOTAL: ${dhPlayerTotal}${dhIsSoft ? ', SOFT' : ''}) ${pJokerTag}`;

        let oddsDealerEl = document.getElementById('dh-odds-dealer');
        let oddsBustEl = document.getElementById('dh-odds-bust');
        let oddsStandEl = document.getElementById('dh-odds-stand');
        let otherPlayersCards = getOtherPlayersKnownCards();

        try {
            let prob = parseFloat(calculateExactBustProbability(dhPlayerHand, [...dhDealerHand, ...otherPlayersCards]));
            if (dhRoundActive && dhPlayerTotal > 0 && prob > 0 && prob < 100) {
                oddsBustEl.innerText = `IF HIT: ${Math.round(prob)}% BUST`;
                oddsBustEl.style.display = 'inline-block';
            } else {
                oddsBustEl.style.display = 'none';
            }
        } catch (err) {
            console.warn('[Casino] bust-odds computation failed:', err);
            oddsBustEl.style.display = 'none';
        }

        try {
            if (dhRoundActive && dhPlayerHand.length > 0 && dhDealerHand.length > 0 && dhPlayerTotal <= 21) {
                let knownExclusions = [...dhPlayerHand, ...otherPlayersCards];
                let standOdds = calculateStandOdds(dhPlayerTotal, dhDealerHand, knownExclusions, dhDealerHoleCardHidden);

                oddsStandEl.innerText = `STAND: ${Math.round(standOdds.win)}% WIN / ${Math.round(standOdds.push)}% PUSH / ${Math.round(standOdds.lose)}% LOSE`;
                oddsStandEl.style.display = 'inline-block';

                oddsDealerEl.innerText = `DEALER BUST: ${Math.round(standOdds.dealerDistribution.bust)}%`;
                oddsDealerEl.style.display = 'inline-block';
            } else {
                oddsStandEl.style.display = 'none';
                oddsDealerEl.style.display = 'none';
            }
        } catch (err) {
            console.warn('[Casino] stand-odds computation failed:', err);
            oddsStandEl.style.display = 'none';
            oddsDealerEl.style.display = 'none';
        }

        updateDhOtherPlayersUI();
    };

    // Other Players At The Table
    let dhStatusIcon = {
        active: '',
        stood: '',
        bust: '✗',
        win: '✓'
    };

    let updateDhOtherPlayersUI = () => {
        let row = document.getElementById('dh-other-players-row');
        let names = Object.keys(dhOtherPlayers);

        if (!dhRoundActive || names.length === 0) {
            row.innerHTML = '';
            return;
        }

        row.innerHTML = names.map(name => {
            let p = dhOtherPlayers[name];
            let icon = dhStatusIcon[p.status] || '';
            let totalLabel = p.total > 0 ? `${p.total}${p.isSoft ? 's' : ''}` : '-';
            return `<div class="dh-op-pill ${p.status}"><span class="dh-op-name">${name}</span><span>${totalLabel}${icon ? ' ' + icon : ''}</span></div>`;
        }).join('');
    };

    // Charts Engine
    let onjatChart = null;
    let dhChart = null;

    let loadChartJS = (callback) => {
        if (window.Chart) {
            callback();
            return;
        }
        let script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        script.onload = callback;
        document.head.appendChild(script);
    };

    let onjatStatsFilter = 'all';
    let dhStatsFilter = 'all';
    let dhSourceFilter = 'all';

    let dhCalendars = {
        oj: {
            selection: new Set(),
            viewDate: new Date(),
            dragging: false
        },
        dh: {
            selection: new Set(),
            viewDate: new Date(),
            dragging: false
        },
    };

    let updateOnjatStatsUI = () => {
        let stats = getFilteredStats(onjatState, onjatStatsFilter, dhCalendars.oj.selection);
        document.getElementById('oj-wins').innerText = stats.wins;
        document.getElementById('oj-losses').innerText = stats.losses;
        document.getElementById('oj-rate').innerText = stats.rate.toFixed(1) + '%';
        let netEl = document.getElementById('oj-net');
        netEl.innerText = formatCurrency(stats.net);
        netEl.className = 'oj-stat-val ' + (stats.net >= 0 ? 'win' : 'loss');
        if (onjatChart) {
            let platHistory = stats.history.map(c => Math.round(c / P_MULTIPLIER));
            onjatChart.data.labels = platHistory.map((_, i) => i);
            onjatChart.data.datasets[0].data = platHistory;
            onjatChart.update();
        }
        saveCasinoData();
    };

    let updateDhStatsUI = () => {
        let stats = getFilteredStats(dhState, dhStatsFilter, dhCalendars.dh.selection, dhSourceFilter);
        document.getElementById('dh-wins').innerText = stats.wins;
        document.getElementById('dh-losses').innerText = stats.losses;
        document.getElementById('dh-rate').innerText = stats.rate.toFixed(1) + '%';
        let netEl = document.getElementById('dh-net');
        netEl.innerText = formatCurrency(stats.net);
        netEl.className = 'oj-stat-val ' + (stats.net >= 0 ? 'win' : 'loss');
        if (dhChart) {
            let platHistory = stats.history.map(c => Math.round(c / P_MULTIPLIER));
            dhChart.data.labels = platHistory.map((_, i) => i);
            dhChart.data.datasets[0].data = platHistory;
            dhChart.update();
        }
        saveCasinoData();
    };

    document.getElementById('oj-stat-filter').addEventListener('click', (e) => {
        if (!e.target.classList.contains('stat-filter-btn')) return;
        onjatStatsFilter = e.target.getAttribute('data-period');
        document.querySelectorAll('#oj-stat-filter .stat-filter-btn').forEach(b => b.classList.toggle('active', b === e.target));
        updateOnjatStatsUI();
    });
    document.getElementById('dh-stat-filter').addEventListener('click', (e) => {
        if (!e.target.classList.contains('stat-filter-btn')) return;
        dhStatsFilter = e.target.getAttribute('data-period');
        document.querySelectorAll('#dh-stat-filter .stat-filter-btn').forEach(b => b.classList.toggle('active', b === e.target));
        updateDhStatsUI();
    });

    document.getElementById('dh-source-filter').addEventListener('click', (e) => {
        if (!e.target.classList.contains('stat-filter-btn')) return;
        dhSourceFilter = e.target.getAttribute('data-source');
        document.querySelectorAll('#dh-source-filter .stat-filter-btn').forEach(b => b.classList.toggle('active', b === e.target));
        updateDhStatsUI();
    });

    // Calendar Filter
    let renderStatCalendar = (prefix) => {
        let cal = dhCalendars[prefix];
        let year = cal.viewDate.getFullYear();
        let month = cal.viewDate.getMonth();
        let firstDayOfWeek = new Date(year, month, 1).getDay();
        let daysInMonth = new Date(year, month + 1, 0).getDate();

        let labelEl = document.getElementById(`${prefix}-cal-month-label`);
        labelEl.innerText = cal.viewDate.toLocaleString('default', {
            month: 'long',
            year: 'numeric'
        });

        let html = '';
        let showImplicitToday = cal.selection.size === 0;
        let todayKey = dayKeyOf(Date.now());
        for (let i = 0; i < firstDayOfWeek; i++) html += `<span class="stat-cal-day empty"></span>`;
        for (let d = 1; d <= daysInMonth; d++) {
            let key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            let selected = cal.selection.has(key);
            let isImplicitToday = !selected && showImplicitToday && key === todayKey;
            let cls = selected ? ' selected' : (isImplicitToday ? ' today-default' : '');
            html += `<span class="stat-cal-day${cls}" data-date="${key}">${d}</span>`;
        }
        let gridEl = document.getElementById(`${prefix}-cal-grid`);
        gridEl.innerHTML = html;
    };

    let setupStatCalendar = (prefix, refreshStats) => {
        let cal = dhCalendars[prefix];
        let popup = document.getElementById(`${prefix}-cal-popup`);
        let gridEl = document.getElementById(`${prefix}-cal-grid`);
        let toggleBtn = document.getElementById(`${prefix}-cal-btn`);
        let clearBtn = document.getElementById(`${prefix}-cal-clear`);

        renderStatCalendar(prefix);

        toggleBtn.addEventListener('click', () => {
            let isOpen = popup.style.display === 'block';
            Object.keys(dhCalendars).forEach(p => {
                document.getElementById(`${p}-cal-popup`).style.display = 'none';
            });
            popup.style.display = isOpen ? 'none' : 'block';
        });

        popup.querySelectorAll('.stat-cal-nav').forEach(navBtn => {
            navBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                let dir = parseInt(navBtn.getAttribute('data-dir'), 10);
                cal.viewDate = new Date(cal.viewDate.getFullYear(), cal.viewDate.getMonth() + dir, 1);
                renderStatCalendar(prefix);
            });
        });

        gridEl.addEventListener('contextmenu', (e) => e.preventDefault());

        gridEl.addEventListener('mousedown', (e) => {
            let cell = e.target.closest('.stat-cal-day:not(.empty)');
            if (!cell) return;
            let dateKey = cell.getAttribute('data-date');

            if (e.button === 2) {
                cal.selection.add(dateKey);
                cal.dragging = true;
            } else if (e.button === 0) {
                cal.selection = new Set([dateKey]);
            } else {
                return;
            }

            renderStatCalendar(prefix);
            refreshStats();
        });

        gridEl.addEventListener('mouseover', (e) => {
            if (!cal.dragging) return;
            let cell = e.target.closest('.stat-cal-day:not(.empty)');
            if (!cell) return;
            let dateKey = cell.getAttribute('data-date');
            if (!cal.selection.has(dateKey)) {
                cal.selection.add(dateKey);
                renderStatCalendar(prefix);
                refreshStats();
            }
        });

        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            cal.selection.clear();
            renderStatCalendar(prefix);
            refreshStats();
        });

        document.addEventListener('click', (e) => {
            if (popup.style.display === 'block' && !popup.contains(e.target) && e.target !== toggleBtn) {
                popup.style.display = 'none';
            }
        });
    };

    document.addEventListener('mouseup', () => {
        dhCalendars.oj.dragging = false;
        dhCalendars.dh.dragging = false;
    });

    setupStatCalendar('oj', updateOnjatStatsUI);
    setupStatCalendar('dh', updateDhStatsUI);

    let initCharts = () => {
        if (window.Chart) {
            let c1 = document.getElementById('oj-chart');
            if (c1 && !onjatChart) {
                onjatChart = new Chart(c1.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: [0],
                        datasets: [{
                            label: 'Net Profit (p)',
                            data: [0],
                            borderColor: '#E4A700',
                            backgroundColor: 'rgba(228, 167, 0, 0.1)',
                            borderWidth: 1.5,
                            pointRadius: 0,
                            pointHoverRadius: 4,
                            pointHitRadius: 12,
                            fill: true,
                            tension: 0.2
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: {
                            mode: 'nearest',
                            intersect: false,
                            axis: 'x'
                        },
                        plugins: {
                            legend: {
                                display: false
                            },
                            tooltip: {
                                displayColors: false
                            }
                        },
                        scales: {
                            x: {
                                display: false
                            },
                            y: {
                                grid: {
                                    color: 'rgba(255,255,255,0.05)'
                                },
                                ticks: {
                                    color: '#bdc3c7',
                                    font: {
                                        size: 9
                                    },
                                    callback: (v) => v + 'p'
                                }
                            }
                        }
                    }
                });
                updateOnjatStatsUI();
            }

            let c2 = document.getElementById('dh-chart');
            if (c2 && !dhChart) {
                dhChart = new Chart(c2.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: [0],
                        datasets: [{
                            label: 'Net Profit (p)',
                            data: [0],
                            borderColor: '#E4A700',
                            backgroundColor: 'rgba(228, 167, 0, 0.1)',
                            borderWidth: 1.5,
                            pointRadius: 0,
                            pointHoverRadius: 4,
                            pointHitRadius: 12,
                            fill: true,
                            tension: 0.2
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: {
                            mode: 'nearest',
                            intersect: false,
                            axis: 'x'
                        },
                        plugins: {
                            legend: {
                                display: false
                            },
                            tooltip: {
                                displayColors: false
                            }
                        },
                        scales: {
                            x: {
                                display: false
                            },
                            y: {
                                grid: {
                                    color: 'rgba(255,255,255,0.05)'
                                },
                                ticks: {
                                    color: '#bdc3c7',
                                    font: {
                                        size: 9
                                    },
                                    callback: (v) => v + 'p'
                                }
                            }
                        }
                    }
                });
                updateDhStatsUI();
            }
        }
    };

    // Roulette Board Highlight & Spinner
    let rSpinTrack = document.getElementById('r-spinner-track');
    let rBoard = document.getElementById('r-board');

    let buildSpinnerTrack = () => {
        let singleSetHtml = wheelOrder.map(num => `<div class="r-pocket ${getPocketClass(num)}">${num}</div>`).join('');
        rSpinTrack.innerHTML = singleSetHtml.repeat(5);
        rSpinTrack.classList.remove('spinning');
        rSpinTrack.style.transition = 'none';
        rSpinTrack.style.transform = `translateX(-1500px)`;
    };
    buildSpinnerTrack();

    let startContinuousSpin = () => {
        rSpinTrack.style.transition = 'none';
        rSpinTrack.classList.add('spinning');
    };
    let spinToNumber = (targetNum) => {
        rSpinTrack.classList.remove('spinning');
        void rSpinTrack.offsetWidth;
        let baseOffsetIndex = 3 * 37;
        let targetIndexInSet = wheelOrder.indexOf(parseInt(targetNum, 10));
        let totalIndex = baseOffsetIndex + targetIndexInSet;
        let pixelOffset = -(totalIndex * 40 + 20);
        rSpinTrack.style.transition = 'transform 3.2s cubic-bezier(0.1, 0.85, 0.15, 1)';
        rSpinTrack.style.transform = `translateX(${pixelOffset}px)`;
    };

    let updateRouletteNetUI = () => {
        let netEl = document.getElementById('r-net');
        netEl.innerText = formatCurrency(rouletteState.netCopper);
        netEl.className = 'oj-stat-val ' + (rouletteState.netCopper >= 0 ? 'win' : 'loss');
        saveCasinoData();
    };

    let getCoveredNumbers = (betKey) => {
        if (!betKey) return [];
        if (/^\d+$/.test(String(betKey))) {
            let num = parseInt(betKey, 10);
            if (num >= 0 && num <= 36) return [num];
        }
        switch (betKey) {
            case '1st12':
                return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
            case '2nd12':
                return [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
            case '3rd12':
                return [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
            case 'col1':
                return [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];
            case 'col2':
                return [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35];
            case 'col3':
                return [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36];
            case 'low':
                return Array.from({
                    length: 18
                }, (_, i) => i + 1);
            case 'high':
                return Array.from({
                    length: 18
                }, (_, i) => i + 19);
            case 'even':
                return Array.from({
                    length: 36
                }, (_, i) => i + 1).filter(n => n % 2 === 0);
            case 'odd':
                return Array.from({
                    length: 36
                }, (_, i) => i + 1).filter(n => n % 2 !== 0);
            case 'red':
                return crimsonNums;
            case 'light':
                return Array.from({
                    length: 36
                }, (_, i) => i + 1).filter(n => !crimsonNums.includes(n));
            default:
                return [];
        }
    };

    let parseBetTarget = (str) => {
        if (!str) return null;
        let s = str.toLowerCase().trim();
        if (s.includes('1st doz') || s.includes('1st12') || s.includes('1-12')) return '1st12';
        if (s.includes('2nd doz') || s.includes('2nd12') || s.includes('13-24')) return '2nd12';
        if (s.includes('3rd doz') || s.includes('3rd12') || s.includes('25-36')) return '3rd12';
        if (s.includes('1st col') || s === 'col1') return 'col1';
        if (s.includes('2nd col') || s === 'col2') return 'col2';
        if (s.includes('3rd col') || s === 'col3') return 'col3';
        if (s.includes('1-18') || s.includes('low')) return 'low';
        if (s.includes('19-36') || s.includes('high')) return 'high';
        if (s.includes('even')) return 'even';
        if (s.includes('odd')) return 'odd';
        if (s.includes('red') || s.includes('crimson')) return 'red';
        if (s.includes('light') || s.includes('black')) return 'light';
        let match = s.match(/\b([0-9]|[12][0-9]|3[0-6])\b(?![a-z])/);
        if (match) return match[1];
        return null;
    };

    rBoard.addEventListener('mouseover', (e) => {
        if (e.target.classList.contains('r-btn')) {
            let betKey = e.target.getAttribute('data-bet');
            getCoveredNumbers(betKey).forEach(n => {
                rBoard.querySelector(`.r-btn[data-bet="${n}"]`).classList.add('hover-highlight');
            });
            e.target.classList.add('hover-highlight');
        }
    });

    rBoard.addEventListener('mouseout', (e) => {
        if (e.target.classList.contains('r-btn')) {
            rBoard.querySelectorAll('.r-btn').forEach(btn => btn.classList.remove('hover-highlight'));
        }
    });

    let clearPreviousSpinHighlights = () => {
        rBoard.querySelectorAll('.r-btn').forEach(btn => btn.classList.remove('winning-pocket', 'bet-win', 'bet-loss', 'bet-active', 'bet-active-pocket'));
    };

    let renderActiveBetHighlights = () => {
        rBoard.querySelectorAll('.r-btn').forEach(btn => btn.classList.remove('bet-active', 'bet-active-pocket'));
        Object.keys(activeBets).forEach(betKey => {
            let btn = rBoard.querySelector(`.r-btn[data-bet="${betKey}"]`);
            btn.classList.add('bet-active');
            getCoveredNumbers(betKey).forEach(n => {
                let pBtn = rBoard.querySelector(`.r-btn[data-bet="${n}"]`);
                if (pBtn !== btn) pBtn.classList.add('bet-active-pocket');
            });
        });
    };

    rBoard.addEventListener('click', (e) => {
        if (e.target.classList.contains('r-btn')) {
            if (isRoundFinished) {
                clearPreviousSpinHighlights();
                spinTotalWagerCopper = 0;
                activeBets = {};
                isRoundFinished = false;
                setRStatus('WAITING FOR BETS', 'var(--c-gold)');
            }
            let target = e.target.getAttribute('data-bet');
            let wagerVal = rBetInput.value || 10;
            sendCommand(`bet ${wagerVal} platinum on ${target}`);
        }
    });

    document.getElementById('btn-r-done').addEventListener('click', () => {
        sendCommand('done');
        startContinuousSpin();
    });

    // View Navigation
    let mainMenu = document.getElementById('palanthas-main-menu');
    let onjatView = document.getElementById('onjat-view');
    let rouletteView = document.getElementById('roulette-view');
    let dhView = document.getElementById('dh-view');
    let currentView = 'menu';

    document.getElementById('btn-open-onjat').addEventListener('click', () => {
        mainMenu.style.display = 'none';
        onjatView.style.display = 'flex';
        currentView = 'onjat';
        loadChartJS(() => {
            setTimeout(() => {
                initCharts();
                updateOnjatStatsUI();
            }, 30);
        });
    });

    document.getElementById('btn-open-roulette').addEventListener('click', () => {
        mainMenu.style.display = 'none';
        rouletteView.style.display = 'flex';
        currentView = 'roulette';
        buildSpinnerTrack();
        updateRouletteNetUI();
    });

    document.getElementById('btn-open-dh').addEventListener('click', () => {
        mainMenu.style.display = 'none';
        dhView.style.display = 'flex';
        currentView = 'dh';
        loadChartJS(() => {
            setTimeout(() => {
                initCharts();
                updateDhStatsUI();
                updateDhUI();
            }, 30);
        });
    });

    document.getElementById('oj-back-to-menu').addEventListener('click', () => {
        onjatView.style.display = 'none';
        mainMenu.style.display = 'flex';
        currentView = 'menu';
    });
    document.getElementById('r-back-to-menu').addEventListener('click', () => {
        rouletteView.style.display = 'none';
        mainMenu.style.display = 'flex';
        currentView = 'menu';
    });
    document.getElementById('dh-back-to-menu').addEventListener('click', () => {
        dhView.style.display = 'none';
        mainMenu.style.display = 'flex';
        currentView = 'menu';
    });

    document.getElementById('rpg-casino-close').addEventListener('click', () => {
        dashboard.remove();
        styles.remove();
        if (window.casinoObserver) window.casinoObserver.disconnect();
        if (dhAutoActive) dhAutoHalt();
    });

    // Save / Load / Clear 
    let refreshAllStatsUI = () => {
        updateOnjatStatsUI();
        updateRouletteNetUI();
        updateDhStatsUI();
        updateDhUI();
    };

    document.getElementById('btn-data-save').addEventListener('click', () => {
        let payload = {
            exportedAt: new Date().toISOString(),
            casino: {
                onjat: onjatState,
                roulette: rouletteState,
                dh: dhState
            }
        };
        let blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: 'application/json'
        });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        let stamp = payload.exportedAt.replace(/[:.]/g, '-');
        a.href = url;
        a.download = `casino-data_${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });

    document.getElementById('btn-data-load').addEventListener('click', () => {
        document.getElementById('dh-data-file-input').click();
    });

    document.getElementById('dh-data-file-input').addEventListener('change', (e) => {
        let file = e.target.files[0];
        e.target.value = ''; // allow re-selecting the same file later
        if (!file) return;
        let reader = new FileReader();
        reader.onload = () => {
            let data;
            try {
                data = JSON.parse(reader.result);
            } catch (err) {
                alert('That file is not valid JSON — nothing was loaded.');
                return;
            }
            if (!data.casino) {
                alert('That file doesn\'t look like a casino data export — nothing was loaded.');
                return;
            }
            if (data.casino.onjat) Object.assign(onjatState, data.casino.onjat);
            if (data.casino.roulette) Object.assign(rouletteState, data.casino.roulette);
            if (data.casino.dh) Object.assign(dhState, data.casino.dh);
            saveCasinoData();
            refreshAllStatsUI();
            alert('Casino data loaded.');
        };
        reader.readAsText(file);
    });

    document.getElementById('btn-data-clear').addEventListener('click', () => {
        if (!confirm('Clear ALL casino stats (Onjat, Wheel of Moons, and Dragon\'s Hand)? This cannot be undone — save a backup first if you want to keep it.')) return;
        Object.assign(onjatState, {
            wins: 0,
            losses: 0,
            netCopper: 0,
            history: [0],
            log: []
        });
        Object.assign(rouletteState, {
            netCopper: 0
        });
        Object.assign(dhState, {
            wins: 0,
            losses: 0,
            pushes: 0,
            netCopper: 0,
            history: [0],
            log: []
        });
        saveCasinoData();
        refreshAllStatsUI();
    });

    // Observer Logic & Parsing
    let setOjStatus = (text, color = 'var(--c-white)') => {
        let el = document.getElementById('oj-status');
        el.innerText = text;
        el.style.color = color;
    };
    let setRStatus = (text, color = 'var(--c-gold)') => {
        let el = document.getElementById('r-status-txt');
        el.innerText = text;
        el.style.color = color;
    };
    let setDhStatus = (text, color = 'var(--c-white)') => {
        let el = document.getElementById('dh-status');
        el.innerText = text;
        el.style.color = color;
    };

    let dhAutoScheduleAct = () => {
        if (!dhAutoActive || !dhAutoAwaitingTurn || dhAutoTurnTimer) return;
        dhAutoTurnTimer = setTimeout(dhAutoAct, dhAutoRandomDelay());
    };

    let dhAutoAct = () => {
        dhAutoTurnTimer = null;
        if (!dhAutoActive || !dhAutoAwaitingTurn || !dhRoundActive) return;
        if (dhPlayerHand.length === 0) return;

        let sig = dhPlayerHand.join('|') + '#' + dhDealerHand.join('|');
        if (sig === dhAutoLastActedSig && (Date.now() - dhAutoLastActedAt) < 1500) return;

        let canDouble = dhAutoIsFirstMove && dhAutoDoubleOffered;
        let decision;
        try {
            decision = decideDhAction(dhAutoParams.allowDouble, canDouble);
        } catch (err) {
            console.warn('[Casino] Auto decision failed, using fallback:', err);
            let fb = evaluateKrynnHand(dhPlayerHand);
            decision = {
                action: fb.total < 17 ? 'hit' : 'stand'
            };
        }

        dhAutoLastActedSig = sig;
        dhAutoLastActedAt = Date.now();
        dhAutoIsFirstMove = false;
        dhAutoAwaitingTurn = false;
        dhAutoLastAction = decision.action;
        if (DH_AUTO_DEBUG) console.log('[Casino Auto]', decision.action, '| hand:', dhPlayerHand.join(', '), '| sig:', sig);
        sendCommand(decision.action);
    };

    window.casinoObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                try {
                    if (node.nodeType === 1) {
                        let text = node.textContent || "";

                        // Onjat Parsing
                        if (currentView === 'onjat') {
                            if (node.classList.contains('outgoing')) {
                                let betMatch = text.match(/bet\s+(\d+)\s+(platinum|gold|silver|copper)/i);
                                if (betMatch) {
                                    currentBetCopper = convertToCopper(parseInt(betMatch[1], 10), betMatch[2]);
                                    setOjStatus(`ANTE PLACED: ${betMatch[1]} ${betMatch[2].toUpperCase()}`, 'var(--c-gold)');
                                }
                            }
                            if (text.match(/New hand!|Place your antes!|Fresh round!|raps twice on the oak|Let's see what you've got|Who's feeling lucky|Antes up/i)) {
                                currentDrift = null;
                                document.getElementById('oj-drift-container').classList.remove('active');
                                document.getElementById('oj-drift-die').innerHTML = '?';
                                ['you', 'house'].forEach(side => {
                                    document.getElementById(`oj-${side}-container`).classList.remove('active');
                                    document.getElementById(`oj-${side}-dice`).innerHTML = `<div class="oj-die">-</div><div class="oj-die">-</div><div class="oj-die">-</div>`;
                                    document.getElementById(`oj-${side}-arch`).innerText = 'ARCH: --';
                                    document.getElementById(`oj-${side}-arch`).className = 'oj-arch-label';
                                });
                                setOjStatus('WAITING FOR ANTE...');
                            }
                            let driftMatch = text.match(/Drift[^\d]{0,15}(\d)/i);
                            if (driftMatch) {
                                currentDrift = driftMatch[1];
                                setOjStatus('DRIFT SET!', 'var(--c-gold)');
                                document.getElementById('oj-drift-container').classList.add('active');
                                document.getElementById('oj-drift-die').innerHTML = getDieIcon(currentDrift);
                            }
                            let diceMatch = text.match(/(\d),\s*(\d),\s*(\d)/);
                            let archMatch = text.match(/An Arch total of (\d+)/i);
                            let isBrix = text.includes('THE BRIX');
                            if (diceMatch && archMatch) {
                                let side = text.toLowerCase().includes('house dealer') ? 'house' : 'you';
                                document.getElementById(`oj-${side}-container`).classList.add('active');

                                let rolledDice = [diceMatch[1], diceMatch[2], diceMatch[3]];
                                document.getElementById(`oj-${side}-dice`).innerHTML = rolledDice.map(d => {
                                    let isMatch = (d === currentDrift) && !isBrix;
                                    return `<div class="oj-die ${isMatch ? 'drift-match' : ''}">${getDieIcon(d)}</div>`;
                                }).join('');

                                let archEl = document.getElementById(`oj-${side}-arch`);
                                archEl.innerHTML = isBrix ? `THE BRIX! (${archMatch[1]})` : `ARCH: ${archMatch[1]}`;
                                archEl.className = isBrix ? 'oj-arch-label brix' : 'oj-arch-label';
                            }
                            if (text.match(/The house's Arch beats yours|sweeping your ante|You lose your ante|The house's Brix takes it all|House wins|edges you out|Dead even. The pit rolls over/i)) {
                                setOjStatus('HOUSE WINS', 'var(--c-red)');
                                onjatState.losses++;
                                onjatState.netCopper -= currentBetCopper;
                                onjatState.history.push(onjatState.netCopper);
                                onjatState.log.push({
                                    ts: Date.now(),
                                    result: 'loss',
                                    netChange: -currentBetCopper
                                });
                                updateOnjatStatsUI();
                            }

                            if (text.match(/takes the round!|takes it!|wins the pit!|wins!/i) && !text.toLowerCase().includes('house')) {
                                setOjStatus('YOU WIN!', 'var(--c-green)');
                                pendingWin = true;
                            }

                            let isPayoutLine = text.match(/(?:snatch up the winnings|scoop up the pit|claim the pit|rake in the pot)/i);
                            if ((pendingWin || isPayoutLine) && text.includes('coins!')) {
                                let payoutCopper = parseTotalCopper(text);
                                if (payoutCopper > 0) {
                                    onjatState.wins++;
                                    onjatState.netCopper += (payoutCopper - currentBetCopper);
                                    onjatState.history.push(onjatState.netCopper);
                                    onjatState.log.push({
                                        ts: Date.now(),
                                        result: 'win',
                                        netChange: payoutCopper - currentBetCopper
                                    });
                                    updateOnjatStatsUI();
                                    setOjStatus(`PAYOUT: ${formatCurrency(payoutCopper)}`, 'var(--c-green)');
                                    pendingWin = false;
                                }
                            }
                        }

                        // Roulette Parsing
                        if (currentView === 'roulette') {
                            let betPlacedMatch = text.match(/You set (\d+)\s+(platinum|gold|silver|copper) coins on (.+?)(?:\s*\(|$)/i);
                            if (betPlacedMatch) {
                                if (isRoundFinished) {
                                    clearPreviousSpinHighlights();
                                    spinTotalWagerCopper = 0;
                                    activeBets = {};
                                    isRoundFinished = false;
                                }
                                let wagerAmt = convertToCopper(parseInt(betPlacedMatch[1], 10), betPlacedMatch[2]);
                                let betKey = parseBetTarget(betPlacedMatch[3]);
                                if (betKey) {
                                    activeBets[betKey] = (activeBets[betKey] || 0) + wagerAmt;
                                    spinTotalWagerCopper += wagerAmt;
                                    renderActiveBetHighlights();
                                    setRStatus(`BET PLACED`, 'var(--c-gold)');
                                }
                            }

                            if ((node.classList.contains('outgoing') && text.match(/^done/i)) || text.match(/flicks the ball|sets the wheel turning|No more bets/i)) {
                                setRStatus('SPINNING...', 'var(--c-white)');
                                startContinuousSpin();
                            }

                            let spinMatch = text.match(/The ball drops!\s*(\d+):/i);
                            if (spinMatch) {
                                let winNum = spinMatch[1];
                                setRStatus(`BALL DROPPED: ${winNum}`, 'var(--c-gold)');
                                spinToNumber(winNum);
                                rBoard.querySelector(`.r-btn[data-bet="${winNum}"]`).classList.add('winning-pocket');
                            }

                            let wagerWinMatch = text.match(/Your wager on (.+?) comes in!/i);
                            if (wagerWinMatch) {
                                let betKey = parseBetTarget(wagerWinMatch[1]);
                                if (betKey) {
                                    let btn = rBoard.querySelector(`.r-btn[data-bet="${betKey}"]`);
                                    btn.classList.remove('bet-active');
                                    btn.classList.add('bet-win');
                                }
                            }

                            let wagerLossMatch = text.match(/Your wager on (.+?) doesn't come in\./i);
                            if (wagerLossMatch) {
                                let betKey = parseBetTarget(wagerLossMatch[1]);
                                if (betKey) {
                                    let btn = rBoard.querySelector(`.r-btn[data-bet="${betKey}"]`);
                                    btn.classList.remove('bet-active');
                                    btn.classList.add('bet-loss');
                                }
                            }

                            if (text.match(/None of your wagers came in/i)) {
                                if (!isRoundFinished && spinTotalWagerCopper > 0) {
                                    rouletteState.netCopper -= spinTotalWagerCopper;
                                    updateRouletteNetUI();
                                    setRStatus(`0c - ${formatCurrency(spinTotalWagerCopper, false)} = ${formatCurrency(-spinTotalWagerCopper, true)}`, 'var(--c-red)');
                                    rBoard.querySelectorAll('.r-btn.bet-active').forEach(b => {
                                        b.classList.remove('bet-active');
                                        b.classList.add('bet-loss');
                                    });
                                }
                                isRoundFinished = true;
                            }

                            if (text.match(/pays out (\d+)\s+(platinum|gold|silver|copper)/i)) {
                                let roundPayoutCopper = parseTotalCopper(text);
                                let netGain = roundPayoutCopper - spinTotalWagerCopper;
                                rouletteState.netCopper += netGain;
                                updateRouletteNetUI();
                                let statusColor = netGain > 0 ? 'var(--c-green)' : (netGain < 0 ? 'var(--c-red)' : 'var(--c-gold)');
                                setRStatus(`${formatCurrency(roundPayoutCopper, false)} - ${formatCurrency(spinTotalWagerCopper, false)} = ${formatCurrency(netGain, true)}`, statusColor);
                                isRoundFinished = true;
                            }
                        }

                        // Dragon's Hand Parsing
                        if (currentView === 'dh') {
                            let dhAnteMatch = text.match(/(?:slide the equivalent of|place a bet of|bet|wager)\s+(\d+)\s+(platinum|gold|silver|copper)/i);
                            if (dhAnteMatch) {
                                dhCurrentBetCopper = convertToCopper(parseInt(dhAnteMatch[1], 10), dhAnteMatch[2]);
                                dhPlayerHand = [];
                                dhDealerHand = [];
                                dhDealerHoleCardHidden = true;
                                dhRoundActive = true;
                                dhOtherPlayers = {};
                                dhDealerDistCache = new Map();
                                dhFrozenCache = new Map();
                                dhEvCache = new Map();
                                dhAutoIsFirstMove = true;
                                dhAutoLastActedSig = '';
                                dhAutoLastActedAt = 0;
                                dhAutoAwaitingTurn = false;
                                dhAutoDoubleOffered = false;
                                dhAutoLastAction = '';
                                if (dhAutoTurnTimer) {
                                    clearTimeout(dhAutoTurnTimer);
                                    dhAutoTurnTimer = null;
                                }
                                setDhStatus(`ANTE PLACED: ${dhAnteMatch[1]} ${dhAnteMatch[2].toUpperCase()}`, 'var(--c-gold)');
                                updateDhUI();
                            }

                            if (node.classList.contains('outgoing') && text.match(/^double/i)) {
                                dhCurrentBetCopper *= 2;
                            }

                            if (text.match(/It.s your turn\.?\s*Choose\s+'hit'/i)) {
                                if (dhAutoActive) {
                                    dhAutoAwaitingTurn = true;
                                    dhAutoDoubleOffered = /'double'/i.test(text);
                                    dhAutoScheduleAct();
                                }
                            }

                            let playerDrawMatch = text.match(/You draw\s+(.+?)(?:\.|\!|\(total|$)/i);
                            if (playerDrawMatch) {
                                let newCard = playerDrawMatch[1].trim().replace(/^(a|an|the)\s+/i, '');
                                if (dhPlayerHand[dhPlayerHand.length - 1] !== newCard) {
                                    dhPlayerHand.push(newCard);
                                    updateDhUI();
                                    dhAutoScheduleAct();
                                }
                            }

                            let dealerDrawMatch = text.match(/(?:The dealer|The lean ink-stained dealer)\s+draws\s+(.+?)(?:\.|\!|$)/i);
                            if (dealerDrawMatch) {
                                let newCard = dealerDrawMatch[1].trim().replace(/^(a|an|the)\s+/i, '');
                                if (dhDealerHand[dhDealerHand.length - 1] !== newCard) {
                                    dhDealerHand.push(newCard);
                                    updateDhUI();
                                }
                                dhAutoAwaitingTurn = false;
                                if (dhAutoTurnTimer) {
                                    clearTimeout(dhAutoTurnTimer);
                                    dhAutoTurnTimer = null;
                                }
                            }

                            let dealerShowMatch = text.match(/(?:The dealer shows|dealer shows)\s+(.+?), with one card/i);
                            if (dealerShowMatch) {
                                let upCard = dealerShowMatch[1].trim().replace(/^(a|an|the)\s+/i, '');
                                dhDealerHand = [upCard];
                                dhDealerHoleCardHidden = true;
                                updateDhUI();
                            }

                            let holeCardMatch = text.match(/(?:turns up the hole card|hidden card is laid bare|reveals the hole card):\s*(.+?)(!|\.|$)/i);
                            if (holeCardMatch) {
                                dhDealerHoleCardHidden = false;
                                let holeCard = holeCardMatch[1].trim().replace(/^(a|an|the)\s+/i, '');
                                if (dhDealerHand.length <= 1) {
                                    dhDealerHand.push(holeCard);
                                } else {
                                    dhDealerHand[1] = holeCard;
                                }
                                updateDhUI();
                            }

                            if (text.match(/The Chronicler misses nothing/i)) {
                                dhDealerHoleCardHidden = false;
                                updateDhUI();
                            }

                            let playerHandMatch = text.match(/Your hand:\s*(.+?)\s*\(total:\s*(\d+)(?:,\s*(soft|BUST))?\)/i);
                            if (playerHandMatch) {
                                dhPlayerHand = playerHandMatch[1].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                dhPlayerTotal = parseInt(playerHandMatch[2], 10);
                                dhIsSoft = (playerHandMatch[3] || '').toLowerCase() === 'soft';
                                updateDhUI();

                                let handBusted = (playerHandMatch[3] || '').toLowerCase() === 'bust' || dhPlayerTotal > 21;
                                if (dhAutoActive && dhRoundActive && dhAutoLastAction === 'hit' && !handBusted) {
                                    dhAutoAwaitingTurn = true;
                                    dhAutoDoubleOffered = false;
                                }
                                dhAutoScheduleAct();
                            }

                            let dealerFullMatch = text.match(/dealer's hand:\s*(.+?)\s*\(total:\s*(\d+)/i);
                            if (dealerFullMatch) {
                                dhDealerHand = dealerFullMatch[1].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                dhDealerHoleCardHidden = false;
                                updateDhUI();
                            }

                            // Other Players At The Table
                            let isOwnOrDealerName = (name) => {
                                let n = name.trim().toLowerCase();
                                return n === 'you' || n === 'your' || n.includes('dealer') || n === playerNameCap.toLowerCase();
                            };
                            let upsertOtherPlayer = (name, handArr, status) => {
                                let cleanName = name.trim();
                                if (isOwnOrDealerName(cleanName)) return;
                                let evalResult = evaluateKrynnHand(handArr);
                                dhOtherPlayers[cleanName] = {
                                    hand: handArr,
                                    total: evalResult.total,
                                    isSoft: evalResult.isSoft,
                                    status
                                };
                            };

                            let otherNaturalMatch = text.match(/^(.+?)\s+throws?\s+down\s+a\s+natural\s+Dragon's Hand:\s*(.+?)\s*\(total:\s*(\d+)/i);
                            if (otherNaturalMatch) {
                                if (!isOwnOrDealerName(otherNaturalMatch[1])) {
                                    let handArr = otherNaturalMatch[2].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                    upsertOtherPlayer(otherNaturalMatch[1], handArr, 'stood');
                                    updateDhOtherPlayersUI();
                                }
                            }

                            let otherHandMatch = text.match(/^(.+?)'s hand:\s*(.+?)\s*\(total:\s*(\d+)(?:,\s*(soft|BUST))?\)/i);
                            if (otherHandMatch && !otherNaturalMatch && !/\bthrows?\s+down\b/i.test(otherHandMatch[1]) && !isOwnOrDealerName(otherHandMatch[1])) {
                                let handArr = otherHandMatch[2].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                let status = (otherHandMatch[4] || '').toLowerCase() === 'bust' ? 'bust' : 'active';
                                upsertOtherPlayer(otherHandMatch[1], handArr, status);
                                updateDhOtherPlayersUI();
                            }

                            let otherDrawMatch = text.match(/^(.+?)\s+draws\s+.+?\.\s*Hand:\s*(.+?)\s*\(total:\s*(\d+)(?:,\s*(soft|BUST))?\)/i);
                            if (otherDrawMatch && !isOwnOrDealerName(otherDrawMatch[1])) {
                                let handArr = otherDrawMatch[2].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                let status = (otherDrawMatch[4] || '').toLowerCase() === 'bust' ? 'bust' : 'active';
                                upsertOtherPlayer(otherDrawMatch[1], handArr, status);
                                updateDhOtherPlayersUI();
                            }

                            let otherBustMatch = text.match(/^(.+?)\s+busts with\s+(.+?)\s*\(total:\s*(\d+)(?:,\s*BUST)?\)/i);
                            if (otherBustMatch && !isOwnOrDealerName(otherBustMatch[1])) {
                                let handArr = otherBustMatch[2].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                upsertOtherPlayer(otherBustMatch[1], handArr, 'bust');
                                updateDhOtherPlayersUI();
                            }

                            let otherStandMatch = text.match(/^(.+?)\s+stands at (?:a clean )?(\d+)/i);
                            if (otherStandMatch && !isOwnOrDealerName(otherStandMatch[1])) {
                                let existing = dhOtherPlayers[otherStandMatch[1].trim()];
                                if (existing) {
                                    existing.status = 'stood';
                                    updateDhOtherPlayersUI();
                                }
                            }

                            let otherWinMatch = text.match(/^(.+?)\s+wins the hand with\s+(.+?)\s*\(total:\s*(\d+)\)/i);
                            if (otherWinMatch && !isOwnOrDealerName(otherWinMatch[1])) {
                                let handArr = otherWinMatch[2].split(',').map(s => s.trim().replace(/^(a|an|the)\s+/i, ''));
                                upsertOtherPlayer(otherWinMatch[1], handArr, 'win');
                                updateDhOtherPlayersUI();
                            }

                            if (text.match(/Dragon's Hand! The lean ink-stained dealer pays you (\d+)\s+(platinum|gold|silver|copper)/i)) {
                                let payoutCopper = parseTotalCopper(text);
                                let netGain = payoutCopper - dhCurrentBetCopper; // payout is 1.5x the ante; net = payout minus the ante that was already risked
                                dhState.wins++;
                                dhState.netCopper += netGain;
                                dhState.history.push(dhState.netCopper);
                                dhState.log.push({
                                    ts: Date.now(),
                                    result: 'win',
                                    netChange: netGain,
                                    source: dhAutoActive ? 'auto' : 'manual'
                                });
                                if (dhAutoActive) dhAutoHandsPlayed++;
                                updateDhStatsUI();
                                dhRoundActive = false;
                                setDhStatus(`NATURAL DRAGON'S HAND! +${formatCurrency(netGain, false)}`, 'var(--c-green)');
                            } else if (text.match(/You win! The lean ink-stained dealer pays you (\d+)\s+(platinum|gold|silver|copper)/i)) {
                                let payoutCopper = parseTotalCopper(text);
                                let netGain = payoutCopper - dhCurrentBetCopper;
                                dhState.wins++;
                                dhState.netCopper += netGain;
                                dhState.history.push(dhState.netCopper);
                                dhState.log.push({
                                    ts: Date.now(),
                                    result: 'win',
                                    netChange: netGain,
                                    source: dhAutoActive ? 'auto' : 'manual'
                                });
                                if (dhAutoActive) dhAutoHandsPlayed++;
                                updateDhStatsUI();
                                dhRoundActive = false;
                                setDhStatus(`YOU WIN! +${formatCurrency(netGain, false)}`, 'var(--c-green)');
                            } else if (text.match(/(?:The lean ink-stained dealer beats your hand|Your hand busted|The ante's gone)/i) && !text.includes('Push')) {
                                dhState.losses++;
                                dhState.netCopper -= dhCurrentBetCopper;
                                dhState.history.push(dhState.netCopper);
                                dhState.log.push({
                                    ts: Date.now(),
                                    result: 'loss',
                                    netChange: -dhCurrentBetCopper,
                                    source: dhAutoActive ? 'auto' : 'manual'
                                });
                                if (dhAutoActive) dhAutoHandsPlayed++;
                                updateDhStatsUI();
                                dhRoundActive = false;
                                setDhStatus(`HOUSE WINS -${formatCurrency(dhCurrentBetCopper, false)}`, 'var(--c-red)');
                            } else if (text.match(/Push\. The lean ink-stained dealer slides your ante back/i)) {
                                dhState.pushes++;
                                dhState.history.push(dhState.netCopper);
                                dhState.log.push({
                                    ts: Date.now(),
                                    result: 'push',
                                    netChange: 0,
                                    source: dhAutoActive ? 'auto' : 'manual'
                                });
                                if (dhAutoActive) dhAutoHandsPlayed++;
                                updateDhStatsUI();
                                dhRoundActive = false;
                                setDhStatus('PUSH - ANTE RETURNED', 'var(--c-gold)');
                            }

                            if (text.match(/Fresh deck, fresh hand\. Antes up|New hand! Antes in|The lean ink-stained dealer raps the table|The lean ink-stained dealer glances around the table/i)) {
                                dhAutoAdvanceOrStop();
                            }
                        }
                    }
                } catch (err) {
                    console.error('[Casino] Error while parsing a line:', err);
                }
            });
        });
    });

    window.casinoObserver.observe(mudOutput, {
        childList: true,
        subtree: true
    });
}
