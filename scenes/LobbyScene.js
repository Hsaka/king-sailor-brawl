import { mainContext, mainCanvasSize, mouseWasPressed, mousePosScreen, isFullscreen, toggleFullscreen } from '../littlejs.esm.min.js';
import { CONFIG } from '../config.js';
import { game, switchScene } from '../App.js';
import { drawScreenText, draw3DButton, drawRoundRect, draw3DCard, hexCss } from '../utils/DrawUtils.js';
import { Animator } from '../utils/Animator.js';
import { FloatingParticles } from '../utils/FloatingParticles.js';
import { createSession, PeerJSTransport, SessionState, PlayerConnectionState } from '../netcode/index.js';
import { WorldState } from '../game/WorldState.js';

let _buttons = [];
function regBtn(x, y, w, h, id, cb) { _buttons.push({ x, y, w, h, id, cb }); }
function hitTest(mx, my) {
    for (let i = _buttons.length - 1; i >= 0; i--) {
        const b = _buttons[i];
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return b;
    }
    return null;
}

export class LobbyScene {
    constructor(data = {}) {
        this.animator = new Animator();
        this.fp = new FloatingParticles();
        this._hovered = null;
        this._displayAlpha = 0;

        this.isHost = data.isHost || false;
        this.worldState = new WorldState();
        this.session = null;
        this.transport = null;
        this.peer = null;

        this.peerId = null;
        this.connectionStatus = 'Connecting...';
        this.playerList = [];
        this.localSelectedShip = 'cobro';
        this.selectedShips = new Map();
        this.ships = CONFIG.SHIPS;
        this.shipIndex = this.ships.findIndex(s => s.id === 'cobro') || 0;
    }

    buildSessionConfig(playerName) {
        const n = CONFIG.NETCODE || {};
        const toPosInt = (v, fallback) => {
            const num = Number(v);
            return Number.isInteger(num) && num > 0 ? num : fallback;
        };
        const toNonNegInt = (v, fallback) => {
            const num = Number(v);
            return Number.isInteger(num) && num >= 0 ? num : fallback;
        };
        const toNonNegNum = (v, fallback) => {
            const num = Number(v);
            return Number.isFinite(num) && num >= 0 ? num : fallback;
        };

        const baseInputDelayTicks = toNonNegInt(n.BASE_INPUT_DELAY_TICKS, 2);
        const maxInputDelayTicks = Math.max(
            baseInputDelayTicks,
            toNonNegInt(n.MAX_INPUT_DELAY_TICKS, 12)
        );

        return {
            debug: false,
            localPlayerName: playerName,
            tickRate: toPosInt(n.TICK_RATE, 60),
            snapshotHistorySize: toPosInt(n.SNAPSHOT_HISTORY, 120),
            maxSpeculationTicks: toPosInt(n.MAX_SPECULATION_TICKS, 60),
            hashInterval: toPosInt(n.HASH_INTERVAL, 60),
            inputRedundancy: toPosInt(n.INPUT_REDUNDANCY, 3),
            disconnectTimeout: toPosInt(n.DISCONNECT_TIMEOUT, 5000),
            inputSizeBytes: toPosInt(n.INPUT_BYTES, 3),
            baseInputDelayTicks,
            maxInputDelayTicks,
            adaptiveInputDelay: typeof n.ADAPTIVE_INPUT_DELAY === 'boolean' ? n.ADAPTIVE_INPUT_DELAY : true,
            adaptiveDelayUpdateInterval: toPosInt(n.ADAPTIVE_DELAY_UPDATE_INTERVAL, 30),
            jitterBufferMs: toNonNegNum(n.JITTER_BUFFER_MS, 8),
        };
    }

    onEnter() {
        _buttons = [];
        this.fp.reset();
        this.animator.animate({ target: this, property: '_displayAlpha', from: 0, to: 1, duration: 0.6, ease: 'easeOut' });

        if (this.isHost) {
            this.hostGame();
        } else {
            setTimeout(() => this.promptJoin(), 100);
        }
    }

    async hostGame() {
        const savedName = localStorage.getItem('playerName') || 'Host';
        const rawName = prompt('Enter your name (Host):', savedName);
        if (rawName === null) {
            switchScene('menu');
            return;
        }
        const playerName = rawName.trim() || 'Host';
        localStorage.setItem('playerName', playerName);

        try {
            this.connectionStatus = 'Creating peer (Host)...';
            this.peer = new Peer();
            this.peer.on('open', (id) => {
                this.peerId = id;
                this.worldState.setLocalPlayerId(id);
                this.worldState.addPlayer(id, 0); // Slot 0
                this.selectedShips.set(id, this.localSelectedShip);
                this.worldState.setPlayerShip(id, this.localSelectedShip);

                this.transport = new PeerJSTransport(id);
                this.transport.setPeerInstance(this.peer);
                this.setupTransportListeners();

                this.session = createSession({
                    game: this.worldState,
                    transport: this.transport,
                    config: this.buildSessionConfig(playerName),
                });
                this.setupSessionListeners();

                this.session.createRoom().then(() => {
                    this.connectionStatus = 'Waiting for players...';
                });
            });
            this.setupPeerListeners();
        } catch (err) {
            this.connectionStatus = `Error: ${err.message}`;
        }
    }

    async promptJoin() {
        const peerId = prompt('Enter Host Room Code (Peer ID):');
        if (!peerId) {
            switchScene('menu');
            return;
        }
        const savedName = localStorage.getItem('playerName') || 'Player';
        const rawName = prompt('Enter your name:', savedName);
        if (rawName === null) {
            switchScene('menu');
            return;
        }
        const playerName = rawName.trim() || 'Player';
        localStorage.setItem('playerName', playerName);

        await this.joinGame(peerId.trim(), playerName);
    }

    async joinGame(hostPeerId, playerName) {
        try {
            this.connectionStatus = 'Creating peer (Client)...';
            this.peer = new Peer();
            this.peer.on('open', async (id) => {
                this.worldState.setLocalPlayerId(id);
                // The host syncs the state which includes player slots.
                this.transport = new PeerJSTransport(id);
                this.transport.setPeerInstance(this.peer);
                this.setupTransportListeners();

                this.session = createSession({
                    game: this.worldState,
                    transport: this.transport,
                    config: this.buildSessionConfig(playerName),
                });
                this.setupSessionListeners();

                this.connectionStatus = 'Connecting to host...';
                try {
                    await this.session.joinRoom(hostPeerId, hostPeerId);
                    this.connectionStatus = 'Connected to lobby';
                } catch (joinErr) {
                    this.connectionStatus = `Failed to join: ${joinErr.message}`;
                }
            });
            this.setupPeerListeners();
        } catch (err) {
            this.connectionStatus = `Error: ${err.message}`;
        }
    }

    setupPeerListeners() {
        this.peer.on('error', (err) => { this.connectionStatus = `Error: ${err.type || err.message}`; });

        this.peer.on('disconnected', () => {
            if (this.peer && !this.peer.destroyed) {
                this.connectionStatus = 'Reconnecting...';
                setTimeout(() => {
                    if (this.peer && !this.peer.destroyed) this.peer.reconnect();
                }, 1000);
            } else {
                this.connectionStatus = 'Disconnected from server';
            }
        });

        if (!this._visibilityHandler) {
            this._visibilityHandler = () => {
                if (document.visibilityState === 'visible' && this.peer && this.peer.disconnected && !this.peer.destroyed) {
                    this.connectionStatus = 'Reconnecting...';
                    this.peer.reconnect();
                }
            };
            document.addEventListener('visibilitychange', this._visibilityHandler);
        }

        this.peer.on('connection', (conn) => {
            if (this.isHost) {
                conn.on('open', () => {
                    conn.send({ __customConfigSync: true, config: CONFIG });
                });
            }
        });
    }

    setupTransportListeners() {
        this.transport.onCustomData = (sender, data) => {
            if (data.type === 'shipSelect') {
                this.selectedShips.set(data.peerId, data.shipId);
                this.worldState.setPlayerShip(data.peerId, data.shipId);
                if (this.isHost) {
                    this.broadcastShip(data.peerId, data.shipId);
                }
            } else if (data.type === 'initialShips') {
                for (const [pId, sId] of Object.entries(data.ships)) {
                    this.selectedShips.set(pId, sId);
                    if (!this.worldState.players.has(pId)) {
                        this.worldState.addPlayer(pId, this.worldState.players.size);
                    }
                    this.worldState.setPlayerShip(pId, sId);
                }

                // Ensure the client re-applies their chosen ship
                const myId = this.getLocalPeerId();
                if (myId) {
                    this.selectedShips.set(myId, this.localSelectedShip);
                    this.worldState.setPlayerShip(myId, this.localSelectedShip);
                    this.broadcastShip(myId, this.localSelectedShip);
                }
            }
        };
    }

    getLocalPeerId() {
        return this.peer?.id || this.session?.localPlayerId || this.peerId || null;
    }

    getHostPeerId() {
        if (this.isHost) {
            return this.getLocalPeerId();
        }

        const hostPlayer = this.session
            ? Array.from(this.session.players.values()).find(player => player.isHost)
            : null;
        if (hostPlayer?.id) {
            return hostPlayer.id;
        }

        const connectedPeers = this.transport?.connectedPeers;
        if (connectedPeers?.size) {
            return connectedPeers.values().next().value;
        }

        return null;
    }

    broadcastShip(peerId, shipId) {
        if (!this.transport) return;
        const msg = { __customData: true, type: 'shipSelect', peerId, shipId };
        if (this.isHost) {
            this.transport.broadcast(msg, true);
        } else {
            const hostPeerId = this.getHostPeerId();
            if (hostPeerId) {
                this.transport.send(hostPeerId, msg, true);
            }
        }
    }

    changeShip(direction) {
        this.shipIndex = (this.shipIndex + direction + this.ships.length) % this.ships.length;
        this.localSelectedShip = this.ships[this.shipIndex].id;

        const myId = this.getLocalPeerId();
        if (myId) {
            this.selectedShips.set(myId, this.localSelectedShip);
            this.worldState.setPlayerShip(myId, this.localSelectedShip);
            this.broadcastShip(myId, this.localSelectedShip);
        }
    }

    setupSessionListeners() {
        this.session.on('playerJoined', (player) => {
            if (!this.worldState.players.has(player.id)) {
                this.worldState.addPlayer(player.id, this.worldState.players.size);
            }
            const selectedShip = this.selectedShips.get(player.id) || 'cobro';
            this.selectedShips.set(player.id, selectedShip);
            this.worldState.setPlayerShip(player.id, selectedShip);

            // Broadcast and coordinate if host
            if (this.isHost) {

                const shipMap = {};
                for (const [id, p] of this.worldState.players) {
                    shipMap[id] = this.selectedShips.get(id) || p.shipId;
                }
                // Small delay to ensure the client is ready to receive
                setTimeout(() => {
                    this.transport.send(player.id, { __customData: true, type: 'initialShips', ships: shipMap }, true);
                }, 100);

                this.broadcastShip(player.id, selectedShip);
            }
        });

        this.session.on('playerLeft', (player) => {
            this.worldState.removePlayer(player.id);
            this.selectedShips.delete(player.id);
            if (player.isHost && !this.isHost) {
                this.disconnect('Host disconnected from the session.');
            }
        });

        this.session.on('stateChange', (newState, oldState) => {
            const stateNames = ['Disconnected', 'Connecting', 'Lobby', 'Playing', 'Paused'];
            this.connectionStatus = stateNames[newState];
            if (newState === SessionState.Playing) {
                // Pre-warm the state before switching
                game.session = this.session;
                game.worldState = this.worldState;
                switchScene('game');
            }
        });
    }

    onUpdate() {
        const dt = 1 / 60;
        this.animator.update(dt);
        this.fp.update(dt, mainCanvasSize.x, mainCanvasSize.y);

        const mp = mousePosScreen;
        this._hovered = hitTest(mp.x, mp.y);

        if (mouseWasPressed(0) && this._hovered) {
            if (game.audioSystem) game.audioSystem.playUIClick();
            this._hovered.cb();
        }

        this.updatePlayerList();
    }

    updatePlayerList() {
        if (!this.session) { this.playerList = []; return; }
        this.playerList = [];

        // Ensure absolute truth by cross-referencing with our actual peer connection ID and the room code we joined
        const myActualId = this.peer ? this.peer.id : this.session.localPlayerId;
        const hostActualId = this.isHost ? myActualId : this.session.roomId;

        for (const [id, player] of this.session.players) {
            if (player.connectionState === PlayerConnectionState.Disconnected) continue;

            const isLocal = id === myActualId;
            const isHost = id === hostActualId;

            const statePlayer = this.worldState.players.get(id);
            this.playerList.push({
                id: player.name || id.slice(0, 6),
                fullId: id,
                isHost,
                isLocal,
                state: player.connectionState === PlayerConnectionState.Connected ? 'Connected' : 'Connecting...',
                ship: statePlayer ? statePlayer.shipId : '...',
            });
        }

        // Sort so the host is always first, and peers are ordered consistently by ID.
        // This ensures colors assigned by index match across all screens.
        this.playerList.sort((a, b) => {
            if (a.isHost && !b.isHost) return -1;
            if (!a.isHost && b.isHost) return 1;
            return a.fullId.localeCompare(b.fullId);
        });
    }

    copyPeerId() {
        if (this.peerId) {
            // Trigger native share synchronously (required by some mobile browsers for user gesture)
            if (navigator.share) {
                navigator.share({
                    title: 'Join my game!',
                    text: `${this.peerId}`
                }).catch(err => console.log('Error sharing:', err));
            }

            navigator.clipboard.writeText(this.peerId).then(() => {
                this.connectionStatus = 'Peer ID copied!';

                setTimeout(() => {
                    if (this.session && this.session.state === SessionState.Lobby) {
                        this.connectionStatus = 'Waiting for players...';
                    }
                }, 2000);
            }).catch(() => {
                this.connectionStatus = 'Failed to copy';
            });
        }
    }

    disconnect(message = null) {
        if (this._visibilityHandler) {
            document.removeEventListener('visibilitychange', this._visibilityHandler);
            this._visibilityHandler = null;
        }

        const sessionToDestroy = this.session;
        this.session = null;
        if (sessionToDestroy) {
            sessionToDestroy.leaveRoom();
            sessionToDestroy.destroy();
        }

        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }

        this.transport = null;
        this.worldState = new WorldState();
        this.isHost = false;
        this.peerId = null;
        this.connectionStatus = 'Disconnected';
        this.playerList = [];

        game.session = null;
        game.worldState = null;

        switchScene('menu', message ? { message } : {});
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

        const backBtnW = 100 * s;
        const backBtnH = 40 * s;
        draw3DButton(20 * s, 20 * s, backBtnW, backBtnH, 'Back', CONFIG.UI.COLORS.DANGER, false, this._hovered?.id === 'back_btn');
        regBtn(20 * s, 20 * s, backBtnW, backBtnH, 'back_btn', () => this.disconnect());

        const fsBtnW = 140 * s;
        const fsBtnH = 40 * s;
        const fsBtnX = sw - fsBtnW - 20 * s;
        const fsBtnY = 20 * s;
        draw3DButton(fsBtnX, fsBtnY, fsBtnW, fsBtnH, isFullscreen() ? 'Windowed' : 'Fullscreen', CONFIG.UI.COLORS.WARNING, false, this._hovered?.id === 'fs_btn');
        regBtn(fsBtnX, fsBtnY, fsBtnW, fsBtnH, 'fs_btn', () => toggleFullscreen());

        drawScreenText('LOBBY', cx, 60 * s, CONFIG.UI.FONT_SIZES.TITLE * s, '#FFFFFF', 'center', 'middle', 'Arial', true);

        // Responsive layout settings
        const isWide = sw > 800 * s;
        const cardWidth = isWide ? Math.min(480 * s, sw * 0.4) : Math.min(600 * s, sw * 0.9);
        const cardHeight = 360 * s;

        const leftX = isWide ? cx - cardWidth - 20 * s : cx - cardWidth / 2;
        const middleY = 120 * s;

        const rightX = isWide ? cx + 20 * s : cx - cardWidth / 2;
        const rightY = isWide ? middleY : middleY + 280 * s;

        // --- Room Details Card (Left) ---
        const leftCardHeight = isWide ? cardHeight : 240 * s;
        draw3DCard(leftX, middleY, cardWidth, leftCardHeight);
        drawScreenText('Room Details', leftX + 24 * s, middleY + 30 * s, 24 * s, '#FFF', 'left', 'middle', 'Arial', true);

        drawScreenText('Status:', leftX + 24 * s, middleY + 80 * s, 18 * s, '#CCC', 'left', 'middle', 'Arial', false);
        drawScreenText(this.connectionStatus, leftX + 90 * s, middleY + 80 * s, 18 * s, hexCss(CONFIG.UI.COLORS.SUCCESS), 'left', 'middle', 'Arial', true);

        if (this.peerId && this.isHost) {
            drawScreenText('Room Code:', leftX + 24 * s, middleY + 130 * s, 18 * s, '#CCC', 'left', 'middle', 'Arial', false);
            drawScreenText(this.peerId, leftX + 24 * s, middleY + 175 * s, 14 * s, hexCss(CONFIG.UI.COLORS.GOLD), 'left', 'middle', 'Arial', true);

            const copyBtnW = 100 * s;
            const copyBtnH = 40 * s;
            const copyBtnX = leftX + cardWidth - copyBtnW - 24 * s;
            const copyBtnY = middleY + 145 * s;
            draw3DButton(copyBtnX, copyBtnY, copyBtnW, copyBtnH, 'Copy', CONFIG.UI.COLORS.PRIMARY, false, this._hovered?.id === 'copy');
            regBtn(copyBtnX, copyBtnY, copyBtnW, copyBtnH, 'copy', () => this.copyPeerId());
        }

        // --- Players Card (Right) ---
        draw3DCard(rightX, rightY, cardWidth, cardHeight);
        drawScreenText('Players', rightX + 24 * s, rightY + 30 * s, 24 * s, '#FFF', 'left', 'middle', 'Arial', true);
        drawScreenText(`${this.playerList.length} / 4`, rightX + cardWidth - 24 * s, rightY + 30 * s, 20 * s, '#CCC', 'right', 'middle', 'Arial', true);

        const listY = rightY + 70 * s;
        this.playerList.forEach((p, i) => {
            const y = listY + i * 65 * s;
            const playerColor = CONFIG.UI.PLAYER_COLORS[i % CONFIG.UI.PLAYER_COLORS.length];

            // Player slot background
            drawRoundRect(rightX + 24 * s, y, cardWidth - 48 * s, 54 * s, 12, 'rgba(0,0,0,0.2)');

            // Color indicator
            drawRoundRect(rightX + 36 * s, y + 17 * s, 20 * s, 20 * s, 10, playerColor);

            // Name & Status
            const label = `${p.id} ${p.isLocal ? '(You)' : ''} ${p.isHost ? '👑' : ''}`;
            drawScreenText(label, rightX + 70 * s, y + 27 * s, 18 * s, '#FFF', 'left', 'middle', 'Arial', true);

            const stateColor = p.state === 'Connected' ? hexCss(CONFIG.UI.COLORS.SUCCESS) : '#CCC';
            drawScreenText(p.state, rightX + cardWidth - 40 * s, y + 27 * s, 14 * s, stateColor, 'right', 'middle', 'Arial', true);
        });

        // --- Action Area (Bottom Center) ---
        const btnW = 240 * s;
        const btnH = 64 * s;
        const btnY = sh - Math.max(100 * s, sh * 0.15); // Dynamic bottom padding

        if (this.session && this.session.state === SessionState.Lobby) {
            // Ship Selection Interface
            const ship = this.ships[this.shipIndex];
            const panelW = 550 * s;
            const panelH = 120 * s;
            const panelX = cx - panelW / 2;
            const panelY = btnY - 170 * s;

            draw3DCard(panelX, panelY, panelW, panelH);
            drawScreenText('Select Ship', cx, panelY + 20 * s, 16 * s, '#CCC', 'center', 'middle');
            drawScreenText(ship.name, cx, panelY + 55 * s, 26 * s, hexCss(CONFIG.UI.COLORS.GOLD), 'center', 'middle', 'Arial', true);
            drawScreenText(ship.description, cx, panelY + 90 * s, 14 * s, '#AAA', 'center', 'middle');

            // Arrows
            const arrowSize = 44 * s;
            const leftArrowX = panelX - arrowSize - 15 * s;
            const rightArrowX = panelX + panelW + 15 * s;

            draw3DButton(leftArrowX, panelY + panelH / 2 - arrowSize / 2, arrowSize, arrowSize, '◀', CONFIG.UI.COLORS.PRIMARY, false, this._hovered?.id === 'prev_ship');
            draw3DButton(rightArrowX, panelY + panelH / 2 - arrowSize / 2, arrowSize, arrowSize, '▶', CONFIG.UI.COLORS.PRIMARY, false, this._hovered?.id === 'next_ship');

            regBtn(leftArrowX, panelY + panelH / 2 - arrowSize / 2, arrowSize, arrowSize, 'prev_ship', () => this.changeShip(-1));
            regBtn(rightArrowX, panelY + panelH / 2 - arrowSize / 2, arrowSize, arrowSize, 'next_ship', () => this.changeShip(1));

            if (this.isHost) {
                draw3DButton(cx - btnW / 2, btnY, btnW, btnH, 'START MATCH', CONFIG.UI.COLORS.GOLD, false, this._hovered?.id === 'start');
                regBtn(cx - btnW / 2, btnY, btnW, btnH, 'start', () => {
                    for (const [id] of this.worldState.players) {
                        const shipId = this.selectedShips.get(id);
                        if (shipId) {
                            this.worldState.setPlayerShip(id, shipId);
                        }
                    }
                    if (this.session.players.size <= 1) {
                        const numBots = CONFIG.COMBAT.BOT_COUNT;
                        const botNames = ['Bot1', 'Bot2', 'Bot3'];
                        for (let i = 0; i < numBots; i++) {
                            const botId = botNames[i] || `Bot${i + 1}`;
                            const nextSlot = this.worldState.players.size;
                            this.worldState.addBot(botId, nextSlot, this.ships[Math.floor(Math.random() * this.ships.length)].id);
                        }
                    }
                    this.session.start();
                });
            } else {
                drawScreenText('Waiting for Host to start...', cx, btnY + 30 * s, 20 * s, '#CCC', 'center', 'middle');
            }
        }

        c.restore();
    }

    onExit() {
        this.animator.clear();
        this.fp.reset();
    }
}
