import { mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen, isFullscreen, toggleFullscreen } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';
import { game, switchScene } from '../App.js';
import { drawScreenText, draw3DButton } from '../utils/DrawUtils.js';
import { Animator } from '../utils/Animator.js';
import { FloatingParticles } from '../utils/FloatingParticles.js';

let _buttons = [];
function regBtn(x, y, w, h, id, cb) {
    _buttons.push({ x, y, w, h, id, cb });
}
function hitTest(mx, my) {
    for (let i = _buttons.length - 1; i >= 0; i--) {
        const b = _buttons[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
    }
    return null;
}

export class MenuScene {
    constructor(data = {}) {
        this.animator = new Animator();
        this.fp = new FloatingParticles();
        this._hovered = null;
        this._displayAlpha = 0;
        this.showPlayOptions = false;
        this.message = data.message || null;
    }

    onEnter(data = {}) {
        _buttons = [];
        this.fp.reset();
        this.showPlayOptions = false;
        if (data && data.message) this.message = data.message;
        this.animator.animate({ target: this, property: '_displayAlpha', from: 0, to: 1, duration: 0.6, ease: 'easeOut' });
    }

    onUpdate() {
        const dt = 1 / 60;
        this.animator.update(dt);
        this.fp.update(dt, mainCanvasSize.x, mainCanvasSize.y);

        const mp = mousePosScreen;
        this._hovered = hitTest(mp.x, mp.y);

        if (mouseWasPressed(0) && this._hovered) {
            if (game.configOverlay && !game.configOverlay.container.classList.contains('hidden')) return;

            if (game.audioSystem) game.audioSystem.playUIClick();
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

        const grad = c.createLinearGradient(0, 0, 0, sh);
        grad.addColorStop(0, CONFIG.BACKGROUND_GRADIENT_LOBBY.START);
        grad.addColorStop(1, CONFIG.BACKGROUND_GRADIENT_LOBBY.END);
        c.fillStyle = grad;
        c.fillRect(0, 0, sw, sh);

        this.fp.render(c, s);

        c.save();
        c.globalAlpha = this._displayAlpha;

        drawScreenText(CONFIG.GAME_TITLE, cx, 100 * s, CONFIG.UI.FONT_SIZES.TITLE * s * 1.5, '#FFFFFF', 'center', 'middle', 'Arial', true);

        if (this.message) {
            drawScreenText(this.message, cx, 180 * s, 24 * s, '#FF6B6B', 'center', 'middle', 'Arial', true);
        }

        // Config button at the top left
        const cfgBtnW = 120 * s;
        const cfgBtnH = 50 * s;
        draw3DButton(20 * s, 20 * s, cfgBtnW, cfgBtnH, 'Config', CONFIG.UI.COLORS.WARNING, false, this._hovered?.id === 'config_btn');
        regBtn(20 * s, 20 * s, cfgBtnW, cfgBtnH, 'config_btn', () => {
            if (game.configOverlay) {
                game.configOverlay.show();
            }
        });

        const btnW = 200 * s * 1.5;
        const btnH = 60 * s * 1.5;
        const startY = cy + 40 * s * 1.5;

        if (!this.showPlayOptions) {
            // Play
            draw3DButton(cx - btnW / 2, startY, btnW, btnH, 'Play', CONFIG.UI.COLORS.PRIMARY, false, this._hovered?.id === 'play');
            regBtn(cx - btnW / 2, startY, btnW, btnH, 'play', () => {
                this.showPlayOptions = true;
            });
        } else {
            // Host
            draw3DButton(cx - btnW / 2, startY, btnW, btnH, 'Host Game', CONFIG.UI.COLORS.PRIMARY, false, this._hovered?.id === 'host');
            regBtn(cx - btnW / 2, startY, btnW, btnH, 'host', () => {
                if (!isFullscreen()) toggleFullscreen();
                switchScene('lobby', { isHost: true });
            });

            // Join
            draw3DButton(cx - btnW / 2, startY + 80 * s * 1.5, btnW, btnH, 'Join Game', CONFIG.UI.COLORS.SUCCESS, false, this._hovered?.id === 'join');
            regBtn(cx - btnW / 2, startY + 80 * s * 1.5, btnW, btnH, 'join', () => {
                if (!isFullscreen()) toggleFullscreen();
                switchScene('lobby', { isHost: false });
            });
        }

        drawScreenText(`v${window.VERSION}`, 10, sh - 20, 16 * s, '#ffd86bff', 'left', 'middle', 'Arial', true);

        c.restore();
    }

    onExit() {
        this.animator.clear();
        this.fp.reset();
    }
}
