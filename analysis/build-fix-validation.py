#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

source = json.loads(Path('analysis/output/browser-harness.json').read_text(encoding='utf-8'))
result = source.get('result', source)
keys = [
    'legacyFullGetsBeforeMutation',
    'lazyInitialVisibleRoles',
    'nativeOlderRoles',
    'nativeOlderAnswerChannel',
    'historyButtonExists',
    'paginationCallsAfterUserScroll',
    'paginationCallsAfterManualClick',
    'userTaskRanBeforeLocalHistory',
    'optimizerWorkerUsed',
    'jsonWorkerParses',
    'sidebarScrollTriggeredRichGeometry',
    'historyCacheHits',
    'richHistoryHasStaticMarkers',
    'richHistoryFenceCount',
    'staticCodeHydrated',
    'staticCodeReady',
    'staticCodeNoCodeMirror',
    'staticCodeHeightStable',
    'offscreenStaticCodeStayedCold',
    'expandOffscreenStaticCodeFilledImmediately',
    'farLargeStaticCodeReleasedDom',
    'staticCodeHotCappedAt1024',
    'evictedStaticCodeRestoredWithDynamicFence',
    'deliveryObserverIdleBeforeSend',
    'deliveryObserverActiveDuringSend',
    'deliveryObserverPausedAfterConfirm',
    'visibilityHookCallsTracked',
    'userTimingMeasuresClean',
    'richMessageContentVisibility',
    'richSmoothedVisible',
    'richOverlayHidden',
    'skippedRichResizeObservers',
]
selected = {key: result.get(key) for key in keys}
checks = {
    'noLegacyFullLoad': selected.get('legacyFullGetsBeforeMutation') == 0,
    'initialHasUserAndAssistant': selected.get('lazyInitialVisibleRoles') == ['user', 'assistant'],
    'historyHasUserAndFinalAssistant': (
        selected.get('nativeOlderRoles') == ['user', 'assistant']
        and selected.get('nativeOlderAnswerChannel') == 'final'
    ),
    'historyIsManual': (
        selected.get('historyButtonExists') is True
        and selected.get('paginationCallsAfterUserScroll') == 0
        and selected.get('paginationCallsAfterManualClick') == 1
    ),
    'interactionRunsBeforeHistoryCommit': selected.get('userTaskRanBeforeLocalHistory') is True,
    'largeJsonUsesWorker': (
        selected.get('optimizerWorkerUsed') is True
        and (selected.get('jsonWorkerParses') or 0) > 0
    ),
    'sidebarScrollDoesNotScanConversation': selected.get('sidebarScrollTriggeredRichGeometry') is False,
    'historyCursorCacheWorks': (selected.get('historyCacheHits') or 0) >= 1,
    'heavyCodeUsesStaticRenderer': (
        selected.get('richHistoryHasStaticMarkers') is True
        and selected.get('richHistoryFenceCount') == 0
        and selected.get('staticCodeHydrated') is True
        and selected.get('staticCodeReady') is True
        and selected.get('staticCodeNoCodeMirror') is True
        and selected.get('staticCodeHeightStable') is True
    ),
    'staticCodeViewportLazyAndUnload': (
        selected.get('offscreenStaticCodeStayedCold') is True
        and selected.get('expandOffscreenStaticCodeFilledImmediately') is True
        and selected.get('farLargeStaticCodeReleasedDom') is True
    ),
    'staticCodeEvictionAndFenceRestore': (
        selected.get('staticCodeHotCappedAt1024') is True
        and selected.get('evictedStaticCodeRestoredWithDynamicFence') is True
    ),
    'deliveryObserverScopedToSend': (
        selected.get('deliveryObserverIdleBeforeSend') is True
        and selected.get('deliveryObserverActiveDuringSend') is True
        and selected.get('deliveryObserverPausedAfterConfirm') is True
    ),
    'perfTelemetryDoesNotLeakMeasures': (
        selected.get('visibilityHookCallsTracked') is True
        and selected.get('userTimingMeasuresClean') is True
    ),
}
report = {
    'allChecksPassed': all(checks.values()),
    'checks': checks,
    'evidence': selected,
}
Path('analysis/output/fix-validation.json').write_text(
    json.dumps(report, indent=2, ensure_ascii=False) + '\n',
    encoding='utf-8',
)
if not report['allChecksPassed']:
    raise SystemExit('One or more fix-validation checks failed')
print(json.dumps(report, indent=2, ensure_ascii=False))
