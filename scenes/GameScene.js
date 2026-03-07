import { vec2, mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen, keyIsDown, keyWasPressed, isUsingGamepad, gamepadStick, gamepadIsDown, gamepadWasPressed } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';
import { game, switchScene } from '../App.js';
import { drawScreenText, draw3DButton, drawRoundRect } from '../utils/DrawUtils.js';
import { Ship } from '../game/Ship.js';
import { Minimap } from '../game/Minimap.js';
import { assetManager } from '../utils/AssetManager.js';
import { HUD } from '../ui/HUD.js';
import { WheelControl } from '../ui/WheelControl.js';
import { SessionState } from '../netcode/index.js';

let _buttons = [];
function regBtn(x, y, w, h, id, cb) { _buttons.push({ x, y, w, h, id, cb }); }
function hitTest(mx, my) {
    for (let i = _buttons.length - 1; i >= 0; i--) {
        const b = _buttons[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
    }
    return null;
}

export class GameScene {
    constructor(data = {}) {
        this.session = game.session;
        this.worldState = game.worldState;
        this.map = CONFIG.MAPS[0]; // 'skyreach' default

        // Camera tracking
        this.camX = 0;
        this.camY = 0;
        this._proceduralClouds = null;

        this.minimap = new Minimap();
        this.hud = new HUD();
        this.gameOverTimer = -1;
        this.spectateId = null;
        this.simTickMs = 1000 / CONFIG.NETCODE.TICK_RATE;
        this.simAccumulatorMs = 0;
        this.simLastTimeMs = 0;
        this.maxCatchUpTicksPerFrame = Math.max(1, CONFIG.NETCODE.MAX_CATCH_UP_TICKS_PER_FRAME || 4);
        this._autoPausedForHidden = false;
        this._visibilityHandler = null;

        // Wheel control scheme
        this.wheelControl = CONFIG.MOVEMENT.WHEEL_CONTROL_SCHEME ? new WheelControl() : null;

        // Monkey-patch: suppress LittleJS left-joystick rendering when wheel is active.
        // We do this once per GameScene construction so it is idempotent.
        if (this.wheelControl && !GameScene._joystickPatched) {
            GameScene._joystickPatched = true;
            GameScene._installJoystickPatch();
        }
    }

    /**
     * Replace the left-joystick arc in inputRender with a no-op so the
     * LittleJS built-in pad only draws the right-side buttons.
     *
     * Strategy: we override the globalAlpha write that gates the entire
     * touchGamepadRender block. Instead we intercept the ctx.arc call for the
     * left stick and skip it.
     *
     * Because we cannot touch littlejs.esm.min.js we patch the CanvasRenderingContext2D
     * prototype's `arc` method only during the LittleJS render phase via a flag.
     */
    static _installJoystickPatch() {
        const originalArc = CanvasRenderingContext2D.prototype.arc;
        CanvasRenderingContext2D.prototype.arc = function (x, y, radius, startAngle, endAngle, anticlockwise) {
            // When the wheel scheme is active and LittleJS is drawing the left stick
            // (which sits near (touchGamepadSize, sh - touchGamepadSize)), skip it.
            if (GameScene._suppressLeftJoystick) {
                // Left stick center is at approximately (GAMEPAD_SIZE, sh - GAMEPAD_SIZE).
                // We identify it by vicinity to that anchor.
                const pad = CONFIG.MOBILE.GAMEPAD_SIZE;
                const sh = this.canvas ? this.canvas.height : 0;
                const expectedCX = pad;
                const expectedCY = sh - pad;
                const dist = Math.hypot(x - expectedCX, y - expectedCY);
                // The left stick arc has a radius of roughly touchGamepadSize/2 which
                // is GAMEPAD_SIZE/2. Anything within ±10% of GAMEPAD_SIZE distance from
                // the expected centre is the left stick — skip it.
                if (dist < pad * 0.5) return;
            }
            return originalArc.call(this, x, y, radius, startAngle, endAngle, anticlockwise);
        };
    }

    getCloudImage() {
        const img = assetManager.getImage('bgClouds');
        if (img) return img;

        if (!this._proceduralClouds) {
            const canvas = document.createElement('canvas');
            const cw = 2400, ch = 2400;
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext('2d');

            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';

            let seed = 1337;
            const rand = () => {
                let t = seed += 0x6D2B79F5;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };

            for (let i = 0; i < 40; i++) {
                const x = rand() * cw;
                const y = rand() * ch;
                const size = 30 + rand() * 60;
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.arc(x + size, y + size * 0.2, size * 0.8, 0, Math.PI * 2);
                ctx.arc(x - size * 0.8, y + size * 0.4, size * 0.7, 0, Math.PI * 2);
                ctx.arc(x + size * 0.3, y - size * 0.5, size * 0.9, 0, Math.PI * 2);
                ctx.fill();
            }
            this._proceduralClouds = canvas;
        }
        return this._proceduralClouds;
    }

    onEnter() {
        _buttons = [];
        if (!this.session) return;
        this.simAccumulatorMs = 0;
        this.simLastTimeMs = performance.now();
        this._autoPausedForHidden = false;

        if (!this._visibilityHandler) {
            this._visibilityHandler = () => this.onVisibilityChange();
            document.addEventListener('visibilitychange', this._visibilityHandler);
        }
        const local = this.worldState.players.get(this.worldState.localPlayerId);
        if (local) {
            this.camX = local.x;
            this.camY = local.y;
            // Initialise wheel heading to the ship's current heading
            if (this.wheelControl) {
                this.wheelControl.targetHeading = local.heading;
            }
        }
        // Attach wheel touch listeners — listen on document like LittleJS does.
        // Pass the last canvas in DOM as the bounding-rect reference for coordinate conversion
        // (LittleJS puts the 2D overlay canvas last, which is on top and has the correct rect).
        if (this.wheelControl) {
            const canvases = document.querySelectorAll('canvas');
            const canvas = canvases[canvases.length - 1] || document.querySelector('canvas');
            this.wheelControl.attach(canvas);
            // Enable left-joystick suppression for the duration of this scene
            GameScene._suppressLeftJoystick = true;
        }
    }

    onVisibilityChange() {
        if (!this.session) return;

        if (document.visibilityState === 'hidden') {
            if (this.session.isHost && this.session.state === SessionState.Playing) {
                this._autoPausedForHidden = true;
                try {
                    this.session.pause();
                } catch { }
            }
            return;
        }

        this.simAccumulatorMs = 0;
        this.simLastTimeMs = performance.now();

        if (this.session.isHost) {
            if (this._autoPausedForHidden && this.session.state === SessionState.Paused) {
                this.session.syncState?.();
                this.session.resume();
            }
            this._autoPausedForHidden = false;
        } else if (this.session.state === SessionState.Playing || this.session.state === SessionState.Paused) {
            this.session.requestSync?.();
        }
    }

    updateLocalInput() {
        let input = 0;

        // ── Keyboard steering (always available) ────────────────────────
        if (keyIsDown(CONFIG.KEYS.TURN_LEFT[0]) || keyIsDown(CONFIG.KEYS.TURN_LEFT[1])) input |= 0x01;
        if (keyIsDown(CONFIG.KEYS.TURN_RIGHT[0]) || keyIsDown(CONFIG.KEYS.TURN_RIGHT[1])) input |= 0x02;
        if (keyIsDown(CONFIG.KEYS.SPEED_UP[0]) || keyIsDown(CONFIG.KEYS.SPEED_UP[1])) input |= 0x04;
        if (keyIsDown(CONFIG.KEYS.SPEED_DOWN[0]) || keyIsDown(CONFIG.KEYS.SPEED_DOWN[1])) input |= 0x08;
        if (keyIsDown(CONFIG.KEYS.PRIMARY_FIRE[0])) input |= 0x10;
        if (keyIsDown(CONFIG.KEYS.SECONDARY_FIRE[0])) input |= 0x20;
        if (keyIsDown(CONFIG.KEYS.SPECIAL_1[0])) input |= 0x40;
        if (keyIsDown(CONFIG.KEYS.SPECIAL_2[0])) input |= 0x80;
        if (keyIsDown(CONFIG.KEYS.SPECIAL_3[0])) input |= 0x100;

        if (this.wheelControl) {
            // ── Wheel control scheme ──────────────────────────────────────
            // IMPORTANT (netcode): We must NOT read local.heading from the
            // speculative WorldState here. Doing so would make the input for
            // tick T depend on the simulated heading at tick T, which diverges
            // between peers during rollback and causes determinism failures.
            //
            // Instead, we encode the wheel's absolute targetHeading directly
            // into the input packet (bits 10-18, 0-359°) plus a WHEEL_ACTIVE
            // flag (bit 19). WorldState.step() then computes the turn bits
            // deterministically from (targetHeading - pdata.heading), using
            // only data already present inside the input word.
            const qHeading = Math.round(((this.wheelControl.targetHeading % 360) + 360) % 360) & 0x1FF; // 9 bits, 0-359
            input |= (qHeading << 10);   // bits 10-18
            input |= (1 << 19);          // bit 19 = WHEEL_ACTIVE

            // Gamepad buttons for weapons/speed (right-side pad still active)
            if (isUsingGamepad) {
                if (gamepadIsDown(0)) input |= 0x10;
                if (gamepadIsDown(1)) input |= 0x20;
                if (gamepadIsDown(2)) input |= 0x08;
                if (gamepadIsDown(3)) input |= 0x04;
                if (gamepadIsDown(4) || gamepadIsDown(5)) input |= 0x100;
            }
        } else {
            // ── Standard joystick scheme ──────────────────────────────────
            if (isUsingGamepad) {
                const stick = gamepadStick(0);
                if (stick.x < -0.2) input |= 0x01;
                if (stick.x > 0.2) input |= 0x02;

                if (gamepadIsDown(0)) input |= 0x10;
                if (gamepadIsDown(1)) input |= 0x20;
                if (gamepadIsDown(2)) input |= 0x08;
                if (gamepadIsDown(3)) input |= 0x04;
                if (gamepadIsDown(4) || gamepadIsDown(5)) input |= 0x100;
            }
        }

        if (this.wantRematch) {
            input |= 0x200;
        }

        // 3 bytes: bits 0-7, bits 8-15, bits 16-23
        const inputArr = new Uint8Array(3);
        inputArr[0] = input & 0xFF;
        inputArr[1] = (input >> 8) & 0xFF;
        inputArr[2] = (input >> 16) & 0xFF;
        return inputArr;
    }

    onUpdate() {
        if (!this.session) return;

        const now = performance.now();
        if (!this.simLastTimeMs) this.simLastTimeMs = now;
        let frameDeltaMs = now - this.simLastTimeMs;
        this.simLastTimeMs = now;
        frameDeltaMs = Math.max(0, Math.min(250, frameDeltaMs));
        this.simAccumulatorMs += frameDeltaMs;

        let ticksToProcess = 1;
        if (this.simTickMs > 0 && this.simAccumulatorMs >= this.simTickMs) {
            const extraTicks = Math.floor(this.simAccumulatorMs / this.simTickMs);
            this.simAccumulatorMs -= extraTicks * this.simTickMs;
            ticksToProcess += extraTicks;
        }
        ticksToProcess = Math.min(this.maxCatchUpTicksPerFrame, ticksToProcess);

        for (let i = 0; i < ticksToProcess; i++) {
            const input = this.updateLocalInput();
            this.session.tick(input);
        }

        if (ticksToProcess === this.maxCatchUpTicksPerFrame && this.simAccumulatorMs > this.simTickMs) {
            this.simAccumulatorMs = this.simTickMs;
        }

        // Update camera targeting smoothly
        let focusId = this.worldState.localPlayerId;
        const local = this.worldState.players.get(focusId);

        if (local && !local.alive) {
            const alivePlayers = Array.from(this.worldState.players.keys()).filter(id => this.worldState.players.get(id).alive);

            if (alivePlayers.length === 1) {
                this.spectateId = alivePlayers[0];
            } else if (keyWasPressed(CONFIG.KEYS.SPECTATE_NEXT[0]) || gamepadWasPressed(0)) {
                if (alivePlayers.length > 0) {
                    if (!this.spectateId || !alivePlayers.includes(this.spectateId)) {
                        this.spectateId = alivePlayers[0];
                    } else {
                        const idx = alivePlayers.indexOf(this.spectateId);
                        this.spectateId = alivePlayers[(idx + 1) % alivePlayers.length];
                    }
                }
            }

            if (this.spectateId && !this.worldState.players.get(this.spectateId).alive) {
                this.spectateId = alivePlayers.length > 0 ? alivePlayers[0] : null;
            }

            if (this.spectateId) {
                focusId = this.spectateId;
            }
        }

        const focusPlayer = this.worldState.players.get(focusId);
        this.focusId = focusId;
        if (focusPlayer) {
            this.camX += (focusPlayer.x - this.camX) * 0.1;
            this.camY += (focusPlayer.y - this.camY) * 0.1;

            // Camera bounds
            const padding = this.map.deathZoneDepth;
            const s = game.scale;
            const sw = mainCanvasSize.x;
            const sh = mainCanvasSize.y;

            // Limit view to stay roughly within death zone + small margin
            const maxCamX = this.map.width + padding - (sw / 2) / s;
            const minCamX = -padding + (sw / 2) / s;
            const maxCamY = this.map.height + padding - (sh / 2) / s;
            const minCamY = -padding + (sh / 2) / s;

            // Only clamp if the map is actually larger than the screen
            if (maxCamX > minCamX) this.camX = Math.max(minCamX, Math.min(maxCamX, this.camX));
            if (maxCamY > minCamY) this.camY = Math.max(minCamY, Math.min(maxCamY, this.camY));
        }

        const mp = mousePosScreen;
        this._hovered = hitTest(mp.x, mp.y);

        if (mouseWasPressed(0) && this._hovered) {
            this._hovered.cb();
        }

        // Win Condition Check
        let aliveCount = 0;
        let lastAlive = null;
        for (const [id, p] of this.worldState.players) {
            if (p.alive) {
                aliveCount++;
                lastAlive = id;
            }
        }

        if (aliveCount <= 1 && this.gameOverTimer === -1) {
            this.gameOverTimer = 2.0; // Wait 2 seconds before showing game over UI
            this.winner = lastAlive;
        }

        if (this.gameOverTimer > 0) {
            this.gameOverTimer -= 1 / 60;
            if (this.gameOverTimer <= 0) {
                this.gameOverTimer = 0;
            }
        }

        // Let's reset the UI flags if the game restarts
        if (aliveCount > 1) {
            this.gameOverTimer = -1;
            this.winner = null;
            this.wantRematch = false;
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

        // Draw Map Background
        const grad = c.createLinearGradient(0, 0, 0, sh);
        grad.addColorStop(0, CONFIG.BACKGROUND_GRADIENT.START);
        grad.addColorStop(1, CONFIG.BACKGROUND_GRADIENT.END);
        c.fillStyle = grad;
        c.fillRect(0, 0, sw, sh);

        if (!this.session) return;

        // Viewport center relative to map
        // Game screen is the full viewport physical dims
        // We calculate offsets for rendering entities based on camera pos
        const renderOffsetX = cx - this.camX * s;
        const renderOffsetY = cy - this.camY * s;

        // Draw clouds with slight parallax
        const bgImg = this.getCloudImage();
        if (bgImg) {
            c.save();
            const parallax = 0.5;
            const imgScale = s * 1.5;
            const imgW = bgImg.width * imgScale;
            const imgH = bgImg.height * imgScale;
            // Modulo to wrap seamlessly
            let ox = (renderOffsetX * parallax) % imgW;
            let oy = (renderOffsetY * parallax) % imgH;
            if (ox > 0) ox -= imgW;
            if (oy > 0) oy -= imgH;

            for (let x = ox - imgW; x < sw + imgW; x += imgW) {
                for (let y = oy - imgH; y < sh + imgH; y += imgH) {
                    c.drawImage(bgImg, x, y, imgW, imgH);
                }
            }
            c.restore();
        }

        // Draw map boundaries
        const mx = renderOffsetX;
        const my = renderOffsetY;
        const mw = this.map.width * s;
        const mh = this.map.height * s;
        c.lineWidth = 4 * s;
        c.strokeStyle = '#FFFFFF';
        c.strokeRect(mx, my, mw, mh);

        // Draw death zone overlay vignette
        // Simplest: fill rects outside the bounds with red tint
        c.fillStyle = `rgba(255,0,0,${CONFIG.DEATH_ZONE.VIGNETTE_ALPHA * 0.3})`;
        c.fillRect(0, 0, sw, Math.max(0, my + this.map.deathZoneDepth * s));
        c.fillRect(0, Math.min(sh, my + mh - this.map.deathZoneDepth * s), sw, sh);
        c.fillRect(0, 0, Math.max(0, mx + this.map.deathZoneDepth * s), sh);
        c.fillRect(Math.min(sw, mx + mw - this.map.deathZoneDepth * s), 0, sw, sh);

        // Render Ships
        for (const [id, pdata] of this.worldState.players) {
            // Reconstruct a temporary ship class for rendering if it doesn't exist, else use WorldState instance
            let ship = this.worldState.shipInstances.get(id);
            if (!ship) {
                ship = new Ship(id, pdata); // Fallback
            } else {
                ship.loadState(pdata);
            }
            const sessionPlayer = this.session?.playerManager.get(id);
            const playerName = sessionPlayer ? sessionPlayer.name : null;
            ship.render(c, s, renderOffsetX, renderOffsetY, 1.0, playerName);
        }

        // Render Debris
        c.fillStyle = '#A0A0A0';
        c.strokeStyle = '#2a2a40';
        c.lineWidth = 2 * s;
        for (const d of this.worldState.debris) {
            let renderedWithSprite = false;
            if (d.spriteKey) {
                const img = assetManager.getImage(d.spriteKey);
                if (img) {
                    const drawSize = d.radius * 2 * s;
                    c.drawImage(img, renderOffsetX + d.x * s - drawSize / 2, renderOffsetY + d.y * s - drawSize / 2, drawSize, drawSize);
                    renderedWithSprite = true;
                }
            }

            if (!renderedWithSprite) {
                c.beginPath();
                c.arc(renderOffsetX + d.x * s, renderOffsetY + d.y * s, d.radius * s, 0, Math.PI * 2);
                if (d.type === 'slow') {
                    c.fillStyle = '#FFDD55'; // Give slow bombs a yellowish tint
                } else {
                    c.fillStyle = '#A0A0A0';
                }
                c.fill();
                c.stroke();
            }
        }

        const renderFocusId = this.focusId || this.worldState.localPlayerId;

        // ── Wheel control render ─────────────────────────────────────────────
        if (this.wheelControl) {
            // Temporarily disable suppress so the wheel's own arc() calls are not filtered.
            // Re-enable immediately after so LittleJS inputRender (runs after gameRender)
            // still sees the flag set and skips the left joystick arc.
            GameScene._suppressLeftJoystick = false;
            this.wheelControl.render(c);
            GameScene._suppressLeftJoystick = true;
        }

        // HUD overlay
        if (this.focusId && this.focusId !== this.worldState.localPlayerId) {
            const specSessionPlayer = this.session?.playerManager.get(this.focusId);
            const specName = specSessionPlayer ? specSessionPlayer.name : this.focusId.slice(0, 6);
            drawScreenText('SPECTATING: ' + specName + ' (FIRE to cycle)', cx, 100 * s, 24 * s, '#FFF', 'center');
        }

        // drawScreenText('Tick: ' + this.session.currentTick, cx, 30 * s, 14 * s, '#FFF', 'center');

        this.hud.render(c, s, this.worldState, renderFocusId);

        // Minimap HUD
        const padding = 20 * s;
        const mmSize = 150 * s;
        this.minimap.render(c, s * 1.5, this.worldState, renderFocusId, sw - mmSize - padding, padding, mmSize);

        // Game Over Overlay
        if (this.gameOverTimer === 0) {
            c.fillStyle = 'rgba(0,0,0,0.5)';
            c.fillRect(0, 0, sw, sh);
            if (this.winner) {
                const winnerPlayer = this.worldState.players.get(this.winner);
                const winSessionPlayer = this.session?.playerManager.get(this.winner);
                const winName = winSessionPlayer && winSessionPlayer.name ? winSessionPlayer.name : this.winner.slice(0, 6);
                const wColor = winnerPlayer ? CONFIG.UI.PLAYER_COLORS[winnerPlayer.slot % CONFIG.UI.PLAYER_COLORS.length] : '#FFF';
                drawScreenText('WINNER: ' + winName, cx, cy - 80 * s, 48 * s, wColor, 'center', 'middle');
            } else {
                drawScreenText('DRAW!', cx, cy - 80 * s, 48 * s, '#FFF', 'center', 'middle');
            }

            // Rematch button
            const localSessionPlayer = this.session?.playerManager.get(this.session?.localPlayerId);
            const isHost = localSessionPlayer && localSessionPlayer.isHost;

            let otherPlayersConnected = 0;
            if (this.session && this.session.players) {
                for (const [id, player] of this.session.players) {
                    if (id !== this.session.localPlayerId && player.connectionState === 1) { // 1 is PlayerConnectionState.Connected
                        otherPlayersConnected++;
                    }
                }
            }

            if (isHost && otherPlayersConnected > 0 && !this.wantRematch) {
                const rBtnW = 200 * s;
                const rBtnH = 50 * s;
                draw3DButton(cx - rBtnW / 2, cy + 20 * s, rBtnW, rBtnH, 'Rematch', CONFIG.UI.COLORS.SUCCESS, false, this._hovered?.id === 'rematch');
                regBtn(cx - rBtnW / 2, cy + 20 * s, rBtnW, rBtnH, 'rematch', () => {
                    this.wantRematch = true;
                });
            } else if (!isHost) {
                drawScreenText('Waiting for host to rematch...', cx, cy + 30 * s, 20 * s, '#CCC', 'center', 'middle');
            }

            // Leave Match button
            const leaveBtnW = 200 * s;
            const leaveBtnH = 50 * s;
            const leaveBtnY = cy + 90 * s;
            draw3DButton(cx - leaveBtnW / 2, leaveBtnY, leaveBtnW, leaveBtnH, 'Leave Match', CONFIG.UI.COLORS.DANGER, false, this._hovered?.id === 'leave_end');
            regBtn(cx - leaveBtnW / 2, leaveBtnY, leaveBtnW, leaveBtnH, 'leave_end', () => {
                this.session.leaveRoom();
                this.session.destroy();
                game.session = null;
                game.worldState = null;
                switchScene('menu');
            });
        }

        const btnW = 100 * s;
        draw3DButton(padding, padding, btnW, 40 * s, 'Leave', 0xFF6B6B, false, this._hovered?.id === 'leave');
        regBtn(padding, padding, btnW, 40 * s, 'leave', () => {
            if (this.session) {
                this.session.leaveRoom();
                this.session.destroy();
            }
            game.session = null;
            game.worldState = null;
            switchScene('menu');
        });

    }

    onExit() {
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }
        // Detach wheel touch listeners
        if (this.wheelControl) {
            this.wheelControl.detach();
        }
        // Reset suppression flag
        GameScene._suppressLeftJoystick = false;
    }
}

// Static flags for the monkey-patch
GameScene._joystickPatched = false;
GameScene._suppressLeftJoystick = false;
