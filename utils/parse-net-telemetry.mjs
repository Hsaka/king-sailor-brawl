#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
    console.error('Usage: node utils/parse-net-telemetry.mjs <telemetry.json>');
}

function safeNumber(v, fallback = 0) {
    return Number.isFinite(v) ? v : fallback;
}

function countBy(items, keyFn) {
    const counts = new Map();
    for (const item of items) {
        const key = keyFn(item);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summarizeHitchWindows(frameEvents) {
    const candidates = frameEvents.filter((e) =>
        e.phase === 'active' && (
            safeNumber(e.rollbacks) > 0 ||
            safeNumber(e.rollbackTicks) > 0 ||
            safeNumber(e.stalledTicks) > 0 ||
            !!e.catchUpClamped ||
            safeNumber(e.teleportSnaps) > 0 ||
            safeNumber(e.rollbackSnapTeleports) > 0
        )
    );

    const windows = [];
    for (const event of candidates) {
        const last = windows[windows.length - 1];
        if (!last || (event.t - last.endT) > 250) {
            windows.push({
                startT: event.t,
                endT: event.t,
                frames: 1,
                rollbacks: safeNumber(event.rollbacks),
                rollbackTicks: safeNumber(event.rollbackTicks),
                stalledTicks: safeNumber(event.stalledTicks),
                catchUpFrames: event.catchUpClamped ? 1 : 0,
                teleportSnaps: safeNumber(event.teleportSnaps),
                rollbackSnapTeleports: safeNumber(event.rollbackSnapTeleports),
                maxDesiredTicks: safeNumber(event.desiredTicks),
                maxWorstBehind: safeNumber(event.worstTicksBehind),
                maxRttMs: safeNumber(event.maxRttMs),
                maxJitterMs: safeNumber(event.maxJitterMs),
            });
            continue;
        }

        last.endT = event.t;
        last.frames += 1;
        last.rollbacks += safeNumber(event.rollbacks);
        last.rollbackTicks += safeNumber(event.rollbackTicks);
        last.stalledTicks += safeNumber(event.stalledTicks);
        last.catchUpFrames += event.catchUpClamped ? 1 : 0;
        last.teleportSnaps += safeNumber(event.teleportSnaps);
        last.rollbackSnapTeleports += safeNumber(event.rollbackSnapTeleports);
        last.maxDesiredTicks = Math.max(last.maxDesiredTicks, safeNumber(event.desiredTicks));
        last.maxWorstBehind = Math.max(last.maxWorstBehind, safeNumber(event.worstTicksBehind));
        last.maxRttMs = Math.max(last.maxRttMs, safeNumber(event.maxRttMs));
        last.maxJitterMs = Math.max(last.maxJitterMs, safeNumber(event.maxJitterMs));
    }

    return windows.sort((a, b) => (b.rollbackTicks + b.stalledTicks) - (a.rollbackTicks + a.stalledTicks));
}

function main() {
    const file = process.argv[2];
    if (!file) {
        usage();
        process.exit(1);
    }

    const absPath = path.resolve(process.cwd(), file);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (error) {
        console.error(`Failed to read/parse telemetry file: ${absPath}`);
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    const events = parsed?.telemetry?.events;
    if (!Array.isArray(events)) {
        console.error('Telemetry payload missing telemetry.events array');
        process.exit(1);
    }

    const counts = new Map();
    for (const e of events) {
        counts.set(e.type, (counts.get(e.type) || 0) + 1);
    }

    const frameEvents = events.filter((e) => e.type === 'frame');
    const activeFrames = frameEvents.filter((e) => e.phase === 'active');
    const awaitingFrames = frameEvents.filter((e) => e.phase === 'awaiting_sync');
    const rollbackEvents = events.filter((e) => e.type === 'rollback');
    const stallEvents = events.filter((e) => e.type === 'tick_stalled');
    const desyncEvents = events.filter((e) => e.type === 'desync');
    const syncedEvents = events.filter((e) => e.type === 'synced');
    const syncRequests = events.filter((e) => e.type === 'sync_request');
    const catchUpEvents = events.filter((e) => e.type === 'catchup_clamped');
    const renderSnapEvents = events.filter((e) => e.type === 'render_snap');
    const syncStateDiffEvents = events.filter((e) => e.type === 'sync_state_diff');
    const staleInputDroppedEvents = events.filter((e) => e.type === 'stale_input_dropped');
    const speculationStallEvents = events.filter((e) => e.type === 'speculation_stall');
    const remoteInputEvents = events.filter((e) => e.type === 'remote_input_event');
    const lateRemoteInputEvents = remoteInputEvents.filter((e) => e.phase === 'late_batch');
    const syncEventsDetailed = events.filter((e) => e.type === 'sync_event');
    const hashEvents = events.filter((e) => e.type === 'hash_event');
    const transportEvents = events.filter((e) => e.type === 'transport_event');
    const messageEvents = events.filter((e) => e.type === 'message_event');

    const maxWorstBehind = activeFrames.reduce((m, e) => Math.max(m, safeNumber(e.worstTicksBehind)), 0);
    const maxRttMs = activeFrames.reduce((m, e) => Math.max(m, safeNumber(e.maxRttMs)), 0);
    const maxJitterMs = activeFrames.reduce((m, e) => Math.max(m, safeNumber(e.maxJitterMs)), 0);
    const maxDesiredTicks = activeFrames.reduce((m, e) => Math.max(m, safeNumber(e.desiredTicks)), 0);
    const totalRollbackTicks = activeFrames.reduce((sum, e) => sum + safeNumber(e.rollbackTicks), 0);
    const totalStalledTicks = activeFrames.reduce((sum, e) => sum + safeNumber(e.stalledTicks), 0);

    const hitchWindows = summarizeHitchWindows(activeFrames);

    console.log('=== Telemetry Summary ===');
    console.log(`file: ${absPath}`);
    console.log(`schema: ${parsed?.schema || parsed?.telemetry?.schema || 'unknown'}`);
    console.log(`startedAt: ${parsed?.startedAtIso || parsed?.telemetry?.startedAtIso || 'unknown'}`);
    console.log(`exportedAt: ${parsed?.exportedAtIso || 'unknown'}`);
    console.log(`events: ${events.length} (dropped: ${parsed?.telemetry?.droppedEvents || 0})`);
    console.log('');
    console.log('Session');
    console.log(`  localPlayerId: ${parsed?.session?.localPlayerId || 'unknown'}`);
    console.log(`  roomId: ${parsed?.session?.roomId || 'unknown'}`);
    console.log(`  isHost: ${parsed?.session?.isHost ?? 'unknown'}`);
    console.log(`  finalTick: ${parsed?.session?.currentTick ?? 'unknown'} (confirmed: ${parsed?.session?.confirmedTick ?? 'unknown'})`);
    console.log('');
    console.log('Core Counters');
    console.log(`  activeFrames: ${activeFrames.length}`);
    console.log(`  awaitingSyncFrames: ${awaitingFrames.length}`);
    console.log(`  rollbacks: ${rollbackEvents.length} (rollbackTicks total from frames: ${totalRollbackTicks})`);
    console.log(`  stalledTicks events: ${stallEvents.length} (stalledTicks total from frames: ${totalStalledTicks})`);
    console.log(`  syncRequests: ${syncRequests.length}, synced: ${syncedEvents.length}, desync: ${desyncEvents.length}`);
    console.log(`  catchUpClamped events: ${catchUpEvents.length}, renderSnap events: ${renderSnapEvents.length}`);
    console.log(`  syncStateDiff events: ${syncStateDiffEvents.length}`);
    console.log(`  staleInputDropped events: ${staleInputDroppedEvents.length}`);
    console.log(`  speculationStall events: ${speculationStallEvents.length}`);
    console.log(`  lateRemoteInput events: ${lateRemoteInputEvents.length}`);
    console.log(`  sync events (detailed): ${syncEventsDetailed.length}, hash events: ${hashEvents.length}`);
    console.log(`  transport events: ${transportEvents.length}, control message events: ${messageEvents.length}`);
    console.log('');
    console.log('Maxima');
    console.log(`  maxWorstBehindTicks: ${maxWorstBehind}`);
    console.log(`  maxRttMs: ${maxRttMs.toFixed(2)}`);
    console.log(`  maxJitterMs: ${maxJitterMs.toFixed(2)}`);
    console.log(`  maxDesiredTicks: ${maxDesiredTicks}`);
    console.log('');

    const sortedCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log('Event Type Counts');
    for (const [type, count] of sortedCounts) {
        console.log(`  ${type}: ${count}`);
    }
    console.log('');

    const aggregateFieldCounts = {};
    for (const ev of syncStateDiffEvents) {
        const fields = ev.fieldCounts || {};
        for (const [k, v] of Object.entries(fields)) {
            aggregateFieldCounts[k] = (aggregateFieldCounts[k] || 0) + safeNumber(v);
        }
    }
    const sortedFieldCounts = Object.entries(aggregateFieldCounts).sort((a, b) => b[1] - a[1]);

    console.log('Sync State Diff Summary');
    if (syncStateDiffEvents.length === 0) {
        console.log('  none');
    } else {
        console.log(`  samples: ${syncStateDiffEvents.length}`);
        if (sortedFieldCounts.length) {
            console.log('  fieldDriftTotals:');
            for (const [field, count] of sortedFieldCounts) {
                console.log(`    ${field}: ${count}`);
            }
        }

        const topDiffs = [...syncStateDiffEvents]
            .sort((a, b) => safeNumber(b.changedPlayerCount) - safeNumber(a.changedPlayerCount))
            .slice(0, 5);
        console.log('  topSyncDiffs:');
        for (const d of topDiffs) {
            const topPlayers = Array.isArray(d.topChangedPlayers) ? d.topChangedPlayers : [];
            const playerSummary = topPlayers
                .slice(0, 3)
                .map((p) => `${(p.id || '?').slice(0, 8)}:pos${safeNumber(p.posDist).toFixed(2)} hp${safeNumber(p.healthDiff).toFixed(2)} kb${safeNumber(p.knockbackDiff).toFixed(2)}`)
                .join(' | ');
            console.log(
                `    tick=${d.tick} snapshot=${d.snapshotTick}` +
                ` epoch=${d.inputEpoch ?? 'n/a'}` +
                ` changedPlayers=${safeNumber(d.changedPlayerCount)}` +
                ` localHash=${d.localHashAtSnapshotTick ?? 'n/a'}` +
                ` syncHash=${d.syncHash ?? 'n/a'}`
            );
            if (playerSummary) {
                console.log(`      players: ${playerSummary}`);
            }
        }
    }
    console.log('');

    const syncPhaseCounts = countBy(syncEventsDetailed, (e) => e.phase || 'unknown');
    const hashPhaseCounts = countBy(hashEvents, (e) => e.phase || 'unknown');
    const transportActionCounts = countBy(transportEvents, (e) => e.action || 'unknown');
    const transportErrorPhaseCounts = countBy(
        transportEvents.filter((e) => e.action === 'error'),
        (e) => e.phase || 'unknown'
    );
    const lateInputByPlayer = countBy(lateRemoteInputEvents, (e) => e.playerId || 'unknown');
    const messageDirectionNameCounts = countBy(
        messageEvents,
        (e) => `${e.direction || '?'}:${e.messageName || e.messageType || 'unknown'}`
    );

    console.log('Diagnostics Summary');
    if (speculationStallEvents.length === 0 &&
        lateRemoteInputEvents.length === 0 &&
        syncEventsDetailed.length === 0 &&
        hashEvents.length === 0 &&
        transportEvents.length === 0) {
        console.log('  none');
    } else {
        if (syncPhaseCounts.length) {
            console.log('  syncPhases:');
            for (const [phase, count] of syncPhaseCounts) {
                console.log(`    ${phase}: ${count}`);
            }
        }
        if (hashPhaseCounts.length) {
            console.log('  hashPhases:');
            for (const [phase, count] of hashPhaseCounts) {
                console.log(`    ${phase}: ${count}`);
            }
        }
        if (transportActionCounts.length) {
            console.log('  transportActions:');
            for (const [action, count] of transportActionCounts) {
                console.log(`    ${action}: ${count}`);
            }
        }
        if (transportErrorPhaseCounts.length) {
            console.log('  transportErrorPhases:');
            for (const [phase, count] of transportErrorPhaseCounts) {
                console.log(`    ${phase}: ${count}`);
            }
        }
        if (speculationStallEvents.length) {
            const maxSpecTicks = speculationStallEvents.reduce((m, e) => Math.max(m, safeNumber(e.speculationTicks)), 0);
            const worstStall = speculationStallEvents
                .slice()
                .sort((a, b) => safeNumber(b.speculationTicks) - safeNumber(a.speculationTicks))[0];
            console.log(`  speculationStalls: ${speculationStallEvents.length} (max speculationTicks=${maxSpecTicks})`);
            if (worstStall) {
                console.log(
                    `    worst: tick=${worstStall.currentTick}` +
                    ` minConfirmed=${worstStall.minConfirmedTick}` +
                    ` slowPeer=${worstStall.slowestPlayerId || 'n/a'}` +
                    ` slowPeerBehind=${safeNumber(worstStall.slowestTicksBehind)}`
                );
            }
        }
        if (lateRemoteInputEvents.length) {
            const maxLateTicks = lateRemoteInputEvents.reduce((m, e) => Math.max(m, safeNumber(e.newestLatenessTicks)), 0);
            console.log(`  lateRemoteInputs: ${lateRemoteInputEvents.length} (max newestLatenessTicks=${maxLateTicks})`);
            if (lateInputByPlayer.length) {
                console.log('  lateRemoteInputsByPlayer:');
                for (const [playerId, count] of lateInputByPlayer.slice(0, 5)) {
                    console.log(`    ${playerId}: ${count}`);
                }
            }
        }
        if (messageEvents.length) {
            const maxIncomingBytes = messageEvents
                .filter((e) => e.direction === 'in')
                .reduce((m, e) => Math.max(m, safeNumber(e.byteLength)), 0);
            const maxOutgoingBytes = messageEvents
                .filter((e) => e.direction === 'out')
                .reduce((m, e) => Math.max(m, safeNumber(e.encodedLength)), 0);
            console.log(`  controlMessageSizes: inMax=${maxIncomingBytes}B outMax=${maxOutgoingBytes}B`);
            if (messageDirectionNameCounts.length) {
                console.log('  controlMessages:');
                for (const [name, count] of messageDirectionNameCounts.slice(0, 10)) {
                    console.log(`    ${name}: ${count}`);
                }
            }
        }
    }
    console.log('');

    console.log('Top Hitch Windows');
    if (hitchWindows.length === 0) {
        console.log('  none');
    } else {
        hitchWindows.slice(0, 10).forEach((w, idx) => {
            console.log(
                `  ${idx + 1}. t=${w.startT.toFixed(1)}-${w.endT.toFixed(1)}ms` +
                ` frames=${w.frames}` +
                ` rb=${w.rollbacks}` +
                ` rbTicks=${w.rollbackTicks}` +
                ` stalled=${w.stalledTicks}` +
                ` clampFrames=${w.catchUpFrames}` +
                ` teleSnaps=${w.teleportSnaps}` +
                ` rbTele=${w.rollbackSnapTeleports}` +
                ` maxBehind=${w.maxWorstBehind}` +
                ` maxRtt=${w.maxRttMs.toFixed(1)}ms` +
                ` maxJitter=${w.maxJitterMs.toFixed(1)}ms`
            );
        });
    }
}

main();
