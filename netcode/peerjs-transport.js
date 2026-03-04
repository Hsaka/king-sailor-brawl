import { MessageType, createPing, createPong } from './messages.js';
import { encodeMessage, decodeMessage, DEFAULT_PROTOCOL_LIMITS } from './encoding.js';
import { CONFIG } from '../config.js';

const DEFAULT_CONNECTION_TIMEOUT_MS = 60000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 5000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 15000;
const RTT_SAMPLE_COUNT = 10;

export class PeerJSTransport {
    constructor(localPeerId, config = {}) {
        this.localPeerId = localPeerId;
        this.connectionTimeout = config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS;
        this.keepaliveInterval = config.keepaliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
        this.keepaliveTimeout = config.keepaliveTimeout ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;

        this.peers = new Map();
        this._connectedPeers = new Set();
        this.peerMetrics = new Map();
        this.keepaliveTimer = null;

        this.onMessage = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this.onError = null;
        this.onKeepalivePing = null;

        this._peer = null;
    }

    get connectedPeers() {
        return this._connectedPeers;
    }

    setPeerInstance(peer) {
        this._peer = peer;
        this.localPeerId = peer.id;

        peer.on('connection', (conn) => {
            this.handleIncomingConnection(conn);
        });

        peer.on('call', (call) => {
        });
    }

    handleIncomingConnection(conn) {
        const peerId = conn.peer;

        if (this.peers.has(peerId)) {
            const existing = this.peers.get(peerId);
            if (existing.connection) {
                existing.connection.close();
            }
        }

        this.setupConnection(peerId, conn);
    }

    setupConnection(peerId, conn) {
        // Reuse existing peerData if present (created by connect() with its
        // Promise resolve/reject). Only allocate a fresh entry for purely
        // incoming connections where no prior entry exists.
        let peerData = this.peers.get(peerId);
        if (!peerData) {
            peerData = {
                connection: conn,
                reliableChannel: null,
                unreliableChannel: null,
                isConnected: false,
                connectionPromise: null,
                connectionResolve: null,
                connectionReject: null,
                connectionTimer: null,
            };
            this.peers.set(peerId, peerData);
        } else {
            peerData.connection = conn;
        }

        conn.on('open', () => {
            peerData.isConnected = true;
            this._connectedPeers.add(peerId);

            if (this._connectedPeers.size === 1 && this.keepaliveInterval > 0) {
                this.startKeepaliveTimer();
            }

            if (peerData.connectionTimer) {
                clearTimeout(peerData.connectionTimer);
                peerData.connectionTimer = null;
            }

            if (peerData.connectionResolve) {
                peerData.connectionResolve();
                peerData.connectionResolve = null;
                peerData.connectionReject = null;
            }

            this.onConnect?.(peerId);
        });

        conn.on('data', (data) => {
            this.recordPeerResponse(peerId);

            if (data && data.__customConfigSync) {
                Object.assign(CONFIG, data.config);
                return;
            }

            if (data && data.__customData) {
                this.onCustomData?.(peerId, data);
                return;
            }

            if (data instanceof ArrayBuffer) {
                this.onMessage?.(peerId, new Uint8Array(data));
            } else if (data instanceof Uint8Array) {
                this.onMessage?.(peerId, data);
            } else if (data && data.buffer instanceof ArrayBuffer) {
                this.onMessage?.(peerId, new Uint8Array(data.buffer));
            } else if (typeof data === 'string') {
                const encoder = new TextEncoder();
                this.onMessage?.(peerId, encoder.encode(data));
            }
        });

        conn.on('close', () => {
            this.handleDisconnect(peerId);
        });

        conn.on('error', (err) => {
            this.onError?.(peerId, err, 'connection');
            if (peerData.connectionReject) {
                peerData.connectionReject(err);
                peerData.connectionResolve = null;
                peerData.connectionReject = null;
            }
        });
    }

    async connect(peerId) {
        if (this._connectedPeers.has(peerId)) {
            return;
        }

        if (!this._peer) {
            throw new Error('Peer instance not set. Call setPeerInstance() first.');
        }

        const existingPeer = this.peers.get(peerId);
        if (existingPeer?.connectionPromise) {
            return existingPeer.connectionPromise;
        }

        const peerData = {
            connection: null,
            reliableChannel: null,
            unreliableChannel: null,
            isConnected: false,
            connectionPromise: null,
            connectionResolve: null,
            connectionReject: null,
            connectionTimer: null,
        };

        this.peers.set(peerId, peerData);

        peerData.connectionPromise = new Promise((resolve, reject) => {
            peerData.connectionResolve = resolve;
            peerData.connectionReject = reject;

            if (this.connectionTimeout > 0) {
                peerData.connectionTimer = setTimeout(() => {
                    if (!peerData.isConnected && peerData.connectionReject) {
                        peerData.connectionReject(new Error(`Connection to ${peerId} timed out`));
                        peerData.connectionResolve = null;
                        peerData.connectionReject = null;
                        peerData.connectionTimer = null;
                        this.cleanupPeer(peerId);
                    }
                }, this.connectionTimeout);
            }

            try {
                const conn = this._peer.connect(peerId);
                peerData.connection = conn;
                this.setupConnection(peerId, conn);
            } catch (err) {
                if (peerData.connectionReject) {
                    peerData.connectionReject(err);
                    peerData.connectionResolve = null;
                    peerData.connectionReject = null;
                }
                if (peerData.connectionTimer) {
                    clearTimeout(peerData.connectionTimer);
                    peerData.connectionTimer = null;
                }
                this.cleanupPeer(peerId);
            }
        });

        return peerData.connectionPromise;
    }

    disconnect(peerId) {
        const peerData = this.peers.get(peerId);
        if (peerData) {
            this.cleanupPeer(peerId);
        }
    }

    disconnectAll() {
        for (const peerId of [...this.peers.keys()]) {
            this.disconnect(peerId);
        }
        this.stopKeepaliveTimer();
    }

    send(peerId, message, reliable) {
        const peerData = this.peers.get(peerId);
        if (!peerData || !peerData.isConnected || !peerData.connection) {
            return;
        }

        try {
            peerData.connection.send(message);
        } catch (err) {
            this.onError?.(peerId, err, 'send');
        }
    }

    broadcast(message, reliable) {
        for (const peerId of this._connectedPeers) {
            this.send(peerId, message, reliable);
        }
    }

    handleDisconnect(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;

        const wasConnected = peerData.isConnected;
        peerData.isConnected = false;
        this._connectedPeers.delete(peerId);

        if (this._connectedPeers.size === 0) {
            this.stopKeepaliveTimer();
        }

        if (peerData.connectionReject) {
            peerData.connectionReject(new Error('Connection closed'));
            peerData.connectionResolve = null;
            peerData.connectionReject = null;
        }

        if (wasConnected) {
            this.onDisconnect?.(peerId);
        }

        this.peers.delete(peerId);
        this.peerMetrics.delete(peerId);
    }

    cleanupPeer(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;

        const wasConnected = peerData.isConnected;

        if (peerData.connectionTimer) {
            clearTimeout(peerData.connectionTimer);
            peerData.connectionTimer = null;
        }

        if (peerData.connection) {
            peerData.connection.close();
        }

        peerData.isConnected = false;
        this._connectedPeers.delete(peerId);
        this.peers.delete(peerId);
        this.peerMetrics.delete(peerId);

        if (this._connectedPeers.size === 0) {
            this.stopKeepaliveTimer();
        }

        if (wasConnected) {
            this.onDisconnect?.(peerId);
        }
    }

    destroy() {
        this.disconnectAll();
        this.stopKeepaliveTimer();
        this.peerMetrics.clear();
    }

    getConnectionMetrics(peerId) {
        const metrics = this.peerMetrics.get(peerId);
        if (!metrics) return null;

        return {
            rtt: metrics.rtt,
            jitter: metrics.jitter,
            packetLoss: metrics.packetLoss,
            lastUpdated: metrics.lastUpdated,
        };
    }

    getOrCreateMetrics(peerId) {
        let metrics = this.peerMetrics.get(peerId);
        if (!metrics) {
            const now = Date.now();
            metrics = {
                rttSamples: [],
                rtt: 0,
                jitter: 0,
                packetLoss: 0,
                lastUpdated: now,
                pendingPings: new Map(),
                lastResponseTime: now,
            };
            this.peerMetrics.set(peerId, metrics);
        }
        return metrics;
    }

    recordPingSent(peerId, timestamp) {
        const metrics = this.getOrCreateMetrics(peerId);
        metrics.pendingPings.set(timestamp, Date.now());
    }

    recordPongReceived(peerId, timestamp) {
        const metrics = this.getOrCreateMetrics(peerId);
        const sentAt = metrics.pendingPings.get(timestamp);

        if (sentAt !== undefined) {
            const rtt = Math.max(0, Date.now() - sentAt);
            this.updateRttMetrics(metrics, rtt);
            metrics.pendingPings.delete(timestamp);
        }
    }

    updateRttMetrics(metrics, rtt) {
        metrics.rttSamples.push(rtt);
        if (metrics.rttSamples.length > RTT_SAMPLE_COUNT) {
            metrics.rttSamples.shift();
        }

        const sum = metrics.rttSamples.reduce((a, b) => a + b, 0);
        metrics.rtt = sum / metrics.rttSamples.length;

        if (metrics.rttSamples.length > 1) {
            const squaredDiffs = metrics.rttSamples.map((sample) => (sample - metrics.rtt) ** 2);
            const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
            metrics.jitter = Math.sqrt(avgSquaredDiff);
        }

        metrics.lastUpdated = Date.now();
    }

    recordPeerResponse(peerId) {
        const metrics = this.getOrCreateMetrics(peerId);
        metrics.lastResponseTime = Date.now();
    }

    startKeepaliveTimer() {
        if (this.keepaliveTimer) return;

        this.keepaliveTimer = setInterval(() => {
            this.checkKeepalives();
        }, this.keepaliveInterval);
    }

    stopKeepaliveTimer() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }

    checkKeepalives() {
        const now = Date.now();

        for (const peerId of this._connectedPeers) {
            const metrics = this.peerMetrics.get(peerId);

            if (metrics && now - metrics.lastResponseTime > this.keepaliveTimeout) {
                const peerData = this.peers.get(peerId);
                if (peerData) {
                    this.handleDisconnect(peerId);
                }
                continue;
            }

            if (this.onKeepalivePing) {
                this.onKeepalivePing(peerId);
            }
        }
    }

    sendPing(peerId, timestamp) {
        this.send(peerId, encodeMessage(createPing(timestamp)), false);
        this.recordPingSent(peerId, timestamp);
    }

    handlePing(peerId, timestamp) {
        this.send(peerId, encodeMessage(createPong(timestamp)), false);
    }

    handlePong(peerId, timestamp) {
        this.recordPongReceived(peerId, timestamp);
    }
}
