import { mainCanvasSize, mainContext, mouseWasPressed, mousePosScreen } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';
import { game, switchScene } from '../App.js';
import { drawScreenText, draw3DButton } from '../utils/DrawUtils.js';

let _buttons = [];
function regBtn(x, y, w, h, id, cb) { _buttons.push({ x, y, w, h, id, cb }); }
function hitTest(mx, my) {
    for (let i = _buttons.length - 1; i >= 0; i--) {
        const b = _buttons[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
    }
    return null;
}

export class ResultsScene {
    constructor(data = {}) {
        this.winner = data.winner;
        this.worldState = game.worldState;
        this.session = game.session;
    }

    onEnter() {
        _buttons = [];
        this._hovered = null;

        // Clear all debris immediately when entering results so rematch is clean
        if (this.worldState) {
            this.worldState.debris = [];
        }
    }

    onUpdate() {
        const mp = mousePosScreen;
        this._hovered = hitTest(mp.x, mp.y);

        if (mouseWasPressed(0) && this._hovered) {
            this._hovered.cb();
        }
    }

    onRender() {
        const c = mainContext;
        const sw = mainCanvasSize.x;
        const sh = mainCanvasSize.y;
        const s = game.scale;
        const cx = sw / 2;
        const cy = sh / 2;
        _buttons = [];

        // BG
        const grad = c.createLinearGradient(0, 0, 0, sh);
        grad.addColorStop(0, '#1a1a2e');
        grad.addColorStop(1, '#2a2a40');
        c.fillStyle = grad;
        c.fillRect(0, 0, sw, sh);

        drawScreenText('MATCH RESULTS', cx, cy - 150 * s, 48 * s, CONFIG.UI.COLORS.PRIMARY, 'center', 'middle');

        if (this.winner) {
            const winnerPlayer = this.worldState?.players.get(this.winner);
            const wColor = winnerPlayer ? CONFIG.UI.PLAYER_COLORS[winnerPlayer.slot % CONFIG.UI.PLAYER_COLORS.length] : '#FFF';
            drawScreenText('WINNER: ' + this.winner.slice(0, 8), cx, cy - 80 * s, 36 * s, wColor, 'center', 'middle');
        } else {
            drawScreenText('DRAW!', cx, cy - 80 * s, 36 * s, '#FFF', 'center', 'middle');
        }

        // Action Buttons
        const btnW = 200 * s;
        const btnH = 60 * s;

        const cleanup = () => {
            if (this.session) {
                this.session.leaveRoom();
                this.session.destroy();
            }
            game.session = null;
            game.worldState = null;
        };

        const isHost = this.session && this.session.isHost;

        if (isHost) {
            draw3DButton(cx - btnW / 2, cy + 50 * s, btnW, btnH, 'Rematch', CONFIG.UI.COLORS.SUCCESS, false, this._hovered?.id === 'rematch');
            regBtn(cx - btnW / 2, cy + 50 * s, btnW, btnH, 'rematch', () => {
                switchScene('lobby', { roomCode: this.session.roomCode, serverId: this.session.roomCode });
            });
        } else if (this.session) {
            // Peers waiting for host...
            drawScreenText('Waiting for Host...', cx, cy + 80 * s, 20 * s, '#FFF', 'center', 'middle');
        }

        draw3DButton(cx - btnW / 2, cy + 130 * s, btnW, btnH, 'Main Menu', CONFIG.UI.COLORS.DANGER, false, this._hovered?.id === 'menu');
        regBtn(cx - btnW / 2, cy + 130 * s, btnW, btnH, 'menu', () => {
            cleanup();
            switchScene('menu');
        });
    }

    onExit() { }
}
