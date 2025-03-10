/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WindowIntervalTimer } from 'vs/base/browser/dom';
import { coalesceInPlace } from 'vs/base/common/arrays';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { Lazy } from 'vs/base/common/lazy';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { themeColorFromId } from 'vs/base/common/themables';
import { ICodeEditor, IViewZone, IViewZoneChangeAccessor } from 'vs/editor/browser/editorBrowser';
import { StableEditorScrollState } from 'vs/editor/browser/stableEditorScroll';
import { LineSource, RenderOptions, renderLines } from 'vs/editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines';
import { EditOperation, ISingleEditOperation } from 'vs/editor/common/core/editOperation';
import { LineRange } from 'vs/editor/common/core/lineRange';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { IEditorDecorationsCollection } from 'vs/editor/common/editorCommon';
import { IModelDecorationsChangeAccessor, IModelDeltaDecoration, ITextModel, IValidEditOperation, OverviewRulerLane } from 'vs/editor/common/model';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { IEditorWorkerService } from 'vs/editor/common/services/editorWorker';
import { InlineDecoration, InlineDecorationType } from 'vs/editor/common/viewModel';
import { localize } from 'vs/nls';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Progress } from 'vs/platform/progress/common/progress';
import { SaveReason } from 'vs/workbench/common/editor';
import { countWords } from 'vs/workbench/contrib/chat/common/chatWordCounter';
import { InlineChatFileCreatePreviewWidget, InlineChatLivePreviewWidget } from 'vs/workbench/contrib/inlineChat/browser/inlineChatLivePreviewWidget';
import { HunkInformation, ReplyResponse, Session } from 'vs/workbench/contrib/inlineChat/browser/inlineChatSession';
import { InlineChatZoneWidget } from 'vs/workbench/contrib/inlineChat/browser/inlineChatWidget';
import { CTX_INLINE_CHAT_CHANGE_HAS_DIFF, CTX_INLINE_CHAT_CHANGE_SHOWS_DIFF, CTX_INLINE_CHAT_DOCUMENT_CHANGED, overviewRulerInlineChatDiffInserted } from 'vs/workbench/contrib/inlineChat/common/inlineChat';
import { HunkState } from './inlineChatSession';
import { assertType } from 'vs/base/common/types';
import { IModelService } from 'vs/editor/common/services/model';
import { performAsyncTextEdit, asProgressiveEdit } from './utils';

export interface IEditObserver {
	start(): void;
	stop(): void;
}

export abstract class EditModeStrategy {

	protected static _decoBlock = ModelDecorationOptions.register({
		description: 'inline-chat',
		showIfCollapsed: false,
		isWholeLine: true,
		className: 'inline-chat-block-selection',
	});

	protected readonly _store = new DisposableStore();
	protected readonly _onDidAccept = this._store.add(new Emitter<void>());
	protected readonly _onDidDiscard = this._store.add(new Emitter<void>());

	protected _editCount: number = 0;

	readonly onDidAccept: Event<void> = this._onDidAccept.event;
	readonly onDidDiscard: Event<void> = this._onDidDiscard.event;

	toggleDiff?: () => any;
	pause?: () => any;

	constructor(
		protected readonly _session: Session,
		protected readonly _editor: ICodeEditor,
		protected readonly _zone: InlineChatZoneWidget,
	) { }

	dispose(): void {
		this._store.dispose();
	}

	abstract apply(): Promise<void>;

	cancel() {
		return this._session.hunkData.discardAll();
	}

	async acceptHunk(): Promise<void> {
		this._onDidAccept.fire();
	}

	async discardHunk(): Promise<void> {
		this._onDidDiscard.fire();
	}

	abstract makeProgressiveChanges(edits: ISingleEditOperation[], obs: IEditObserver, timings: ProgressingEditsOptions): Promise<void>;

	abstract makeChanges(edits: ISingleEditOperation[], obs: IEditObserver): Promise<void>;

	protected async _makeChanges(edits: ISingleEditOperation[], obs: IEditObserver, opts: ProgressingEditsOptions | undefined, progress: Progress<IValidEditOperation[]> | undefined): Promise<void> {

		// push undo stop before first edit
		if (++this._editCount === 1) {
			this._editor.pushUndoStop();
		}

		if (opts) {
			// ASYNC
			const durationInSec = opts.duration / 1000;
			for (const edit of edits) {
				const wordCount = countWords(edit.text ?? '');
				const speed = wordCount / durationInSec;
				// console.log({ durationInSec, wordCount, speed: wordCount / durationInSec });
				const asyncEdit = asProgressiveEdit(new WindowIntervalTimer(this._zone.domNode), edit, speed, opts.token);
				await performAsyncTextEdit(this._session.textModelN, asyncEdit, progress, obs);
			}

		} else {
			// SYNC
			obs.start();
			this._session.textModelN.pushEditOperations(null, edits, (undoEdits) => {
				progress?.report(undoEdits);
				return null;
			});
			obs.stop();
		}
	}

	abstract undoChanges(altVersionId: number): Promise<void>;

	abstract renderChanges(response: ReplyResponse): Promise<Position | undefined>;

	abstract hasFocus(): boolean;

	getWholeRangeDecoration(): IModelDeltaDecoration[] {
		const ranges = [this._session.wholeRange.value];
		const newDecorations = ranges.map(range => range.isEmpty() ? undefined : ({ range, options: EditModeStrategy._decoBlock }));
		coalesceInPlace(newDecorations);
		return newDecorations;
	}
}

export class PreviewStrategy extends EditModeStrategy {

	private readonly _ctxDocumentChanged: IContextKey<boolean>;

	constructor(
		session: Session,
		editor: ICodeEditor,
		zone: InlineChatZoneWidget,
		@IModelService modelService: IModelService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(session, editor, zone);

		this._ctxDocumentChanged = CTX_INLINE_CHAT_DOCUMENT_CHANGED.bindTo(contextKeyService);

		const baseModel = modelService.getModel(session.targetUri)!;
		Event.debounce(baseModel.onDidChangeContent.bind(baseModel), () => { }, 350)(_ => {
			if (!baseModel.isDisposed() && !session.textModel0.isDisposed()) {
				this._ctxDocumentChanged.set(session.hasChangedText);
			}
		}, undefined, this._store);
	}

	override dispose(): void {
		this._ctxDocumentChanged.reset();
		super.dispose();
	}

	async apply() {

		// (1) ensure the editor still shows the original text
		// (2) accept all pending hunks (moves changes from N to 0)
		// (3) replace editor model with textModel0
		const textModel = this._editor.getModel();
		if (textModel?.equalsTextBuffer(this._session.textModel0.getTextBuffer())) {

			this._session.hunkData.getInfo().forEach(item => item.acceptChanges());

			const newText = this._session.textModel0.getValue();
			const range = textModel.getFullModelRange();

			textModel.pushStackElement();
			textModel.pushEditOperations(null, [EditOperation.replace(range, newText)], () => null);
			textModel.pushStackElement();
		}

		if (this._session.lastExchange?.response instanceof ReplyResponse) {
			const { untitledTextModel } = this._session.lastExchange.response;
			if (untitledTextModel && !untitledTextModel.isDisposed() && untitledTextModel.isDirty()) {
				await untitledTextModel.save({ reason: SaveReason.EXPLICIT });
			}
		}
	}

	override async makeChanges(edits: ISingleEditOperation[], obs: IEditObserver): Promise<void> {
		return this._makeChanges(edits, obs, undefined, undefined);
	}

	override async makeProgressiveChanges(edits: ISingleEditOperation[], obs: IEditObserver, opts: ProgressingEditsOptions): Promise<void> {
		return this._makeChanges(edits, obs, opts, undefined);
	}

	override async undoChanges(altVersionId: number): Promise<void> {
		const { textModelN } = this._session;
		await undoModelUntil(textModelN, altVersionId);
	}

	override async renderChanges(response: ReplyResponse): Promise<undefined> {
		if (response.allLocalEdits.length > 0) {
			await this._zone.widget.showEditsPreview(this._session.textModel0, this._session.textModelN);
		} else {
			this._zone.widget.hideEditsPreview();
		}

		if (response.untitledTextModel) {
			this._zone.widget.showCreatePreview(response.untitledTextModel);
		} else {
			this._zone.widget.hideCreatePreview();
		}
	}

	hasFocus(): boolean {
		return this._zone.widget.hasFocus();
	}
}


export interface ProgressingEditsOptions {
	duration: number;
	token: CancellationToken;
}

export class LivePreviewStrategy extends EditModeStrategy {

	private readonly _previewZone: Lazy<InlineChatFileCreatePreviewWidget>;
	private readonly _diffZonePool: InlineChatLivePreviewWidget[] = [];

	constructor(
		session: Session,
		editor: ICodeEditor,
		zone: InlineChatZoneWidget,
		@IInstantiationService private readonly _instaService: IInstantiationService,
	) {
		super(session, editor, zone);

		this._previewZone = new Lazy(() => _instaService.createInstance(InlineChatFileCreatePreviewWidget, editor));
	}

	override dispose(): void {
		for (const zone of this._diffZonePool) {
			zone.hide();
			zone.dispose();
		}
		this._previewZone.rawValue?.hide();
		this._previewZone.rawValue?.dispose();
		super.dispose();
	}

	async apply() {
		if (this._editCount > 0) {
			this._editor.pushUndoStop();
		}
		if (!(this._session.lastExchange?.response instanceof ReplyResponse)) {
			return;
		}
		const { untitledTextModel } = this._session.lastExchange.response;
		if (untitledTextModel && !untitledTextModel.isDisposed() && untitledTextModel.isDirty()) {
			await untitledTextModel.save({ reason: SaveReason.EXPLICIT });
		}
	}

	override async undoChanges(altVersionId: number): Promise<void> {
		const { textModelN } = this._session;
		await undoModelUntil(textModelN, altVersionId);
		this._updateDiffZones();
	}

	override async makeChanges(edits: ISingleEditOperation[], obs: IEditObserver): Promise<void> {
		return this._makeChanges(edits, obs, undefined, undefined);
	}

	override async makeProgressiveChanges(edits: ISingleEditOperation[], obs: IEditObserver, opts: ProgressingEditsOptions): Promise<void> {
		await this._makeChanges(edits, obs, opts, new Progress<any>(() => {
			this._updateDiffZones();
		}));
	}

	override async renderChanges(response: ReplyResponse): Promise<Position | undefined> {

		if (response.untitledTextModel && !response.untitledTextModel.isDisposed()) {
			this._previewZone.value.showCreation(this._session.wholeRange.value.getStartPosition().delta(-1), response.untitledTextModel);
		} else {
			this._previewZone.value.hide();
		}

		return this._updateDiffZones();
	}


	protected _updateSummaryMessage(hunkCount: number) {
		let message: string;
		if (hunkCount === 0) {
			message = localize('change.0', "Nothing changed");
		} else if (hunkCount === 1) {
			message = localize('change.1', "1 change");
		} else {
			message = localize('lines.NM', "{0} changes", hunkCount);
		}
		this._zone.widget.updateStatus(message);
	}


	private _updateDiffZones(): Position | undefined {

		const { hunkData } = this._session;
		const hunks = hunkData.getInfo().filter(hunk => hunk.getState() === HunkState.Pending);

		if (hunks.length === 0) {
			for (const zone of this._diffZonePool) {
				zone.hide();
			}

			if (hunkData.getInfo().find(hunk => hunk.getState() === HunkState.Accepted)) {
				this._onDidAccept.fire();
			} else {
				this._onDidDiscard.fire();
			}

			return;
		}

		this._updateSummaryMessage(hunks.length);

		// create enough zones
		const handleDiff = () => this._updateDiffZones();

		type Data = { position: Position; distance: number; accept: Function; discard: Function };
		let nearest: Data | undefined;

		// create enough zones
		while (hunks.length > this._diffZonePool.length) {
			this._diffZonePool.push(this._instaService.createInstance(InlineChatLivePreviewWidget, this._editor, this._session, {}, this._diffZonePool.length === 0 ? handleDiff : undefined));
		}

		for (let i = 0; i < hunks.length; i++) {
			const hunk = hunks[i];
			this._diffZonePool[i].showForChanges(hunk);

			const modifiedRange = hunk.getRangesN()[0];
			const zoneLineNumber = this._zone.position!.lineNumber;
			const distance = zoneLineNumber <= modifiedRange.startLineNumber
				? modifiedRange.startLineNumber - zoneLineNumber
				: zoneLineNumber - modifiedRange.endLineNumber;

			if (!nearest || nearest.distance > distance) {
				nearest = {
					position: modifiedRange.getStartPosition().delta(-1),
					distance,
					accept: () => {
						hunk.acceptChanges();
						handleDiff();
					},
					discard: () => {
						hunk.discardChanges();
						handleDiff();
					}
				};
			}

		}
		// hide unused zones
		for (let i = hunks.length; i < this._diffZonePool.length; i++) {
			this._diffZonePool[i].hide();
		}

		this.acceptHunk = async () => nearest?.accept();
		this.discardHunk = async () => nearest?.discard();

		if (nearest) {
			this._zone.updatePositionAndHeight(nearest.position);
			this._editor.revealPositionInCenterIfOutsideViewport(nearest.position);
		}

		return nearest?.position;
	}

	override hasFocus(): boolean {
		return this._zone.widget.hasFocus()
			|| Boolean(this._previewZone.rawValue?.hasFocus())
			|| this._diffZonePool.some(zone => zone.isVisible && zone.hasFocus());
	}
}

type HunkDisplayData = {

	decorationIds: string[];

	viewZoneId: string | undefined;
	viewZone: IViewZone;

	distance: number;
	position: Position;
	acceptHunk: () => void;
	discardHunk: () => void;
	toggleDiff?: () => any;
	remove(): void;
};


export class LiveStrategy extends EditModeStrategy {

	private readonly _decoInsertedText = ModelDecorationOptions.register({
		description: 'inline-modified-line',
		className: 'inline-chat-inserted-range-linehighlight',
		isWholeLine: true,
		overviewRuler: {
			position: OverviewRulerLane.Full,
			color: themeColorFromId(overviewRulerInlineChatDiffInserted),
		}
	});

	private readonly _decoInsertedTextRange = ModelDecorationOptions.register({
		description: 'inline-chat-inserted-range-linehighlight',
		className: 'inline-chat-inserted-range',
	});

	private readonly _previewZone: Lazy<InlineChatFileCreatePreviewWidget>;

	private readonly _ctxCurrentChangeHasDiff: IContextKey<boolean>;
	private readonly _ctxCurrentChangeShowsDiff: IContextKey<boolean>;

	private readonly _progressiveEditingDecorations: IEditorDecorationsCollection;


	override acceptHunk: () => Promise<void> = () => super.acceptHunk();
	override discardHunk: () => Promise<void> = () => super.discardHunk();

	constructor(
		session: Session,
		editor: ICodeEditor,
		zone: InlineChatZoneWidget,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorWorkerService protected readonly _editorWorkerService: IEditorWorkerService,
		@IInstantiationService protected readonly _instaService: IInstantiationService,
	) {
		super(session, editor, zone);
		this._ctxCurrentChangeHasDiff = CTX_INLINE_CHAT_CHANGE_HAS_DIFF.bindTo(contextKeyService);
		this._ctxCurrentChangeShowsDiff = CTX_INLINE_CHAT_CHANGE_SHOWS_DIFF.bindTo(contextKeyService);

		this._progressiveEditingDecorations = this._editor.createDecorationsCollection();
		this._previewZone = new Lazy(() => _instaService.createInstance(InlineChatFileCreatePreviewWidget, editor));

	}

	override dispose(): void {
		this._resetDiff();
		this._previewZone.rawValue?.dispose();
		super.dispose();
	}

	private _resetDiff(): void {
		this._ctxCurrentChangeHasDiff.reset();
		this._ctxCurrentChangeShowsDiff.reset();
		this._zone.widget.updateStatus('');
		this._progressiveEditingDecorations.clear();


		for (const data of this._hunkDisplayData.values()) {
			data.remove();
		}
	}

	override pause = () => {
		this._ctxCurrentChangeShowsDiff.reset();
	};

	async apply() {
		this._resetDiff();
		if (this._editCount > 0) {
			this._editor.pushUndoStop();
		}
		if (!(this._session.lastExchange?.response instanceof ReplyResponse)) {
			return;
		}
		const { untitledTextModel } = this._session.lastExchange.response;
		if (untitledTextModel && !untitledTextModel.isDisposed() && untitledTextModel.isDirty()) {
			await untitledTextModel.save({ reason: SaveReason.EXPLICIT });
		}
	}

	override cancel() {
		this._resetDiff();
		return super.cancel();
	}

	override async undoChanges(altVersionId: number): Promise<void> {
		const { textModelN } = this._session;
		await undoModelUntil(textModelN, altVersionId);
	}

	override async makeChanges(edits: ISingleEditOperation[], obs: IEditObserver): Promise<void> {
		return this._makeChanges(edits, obs, undefined, undefined);
	}

	override async makeProgressiveChanges(edits: ISingleEditOperation[], obs: IEditObserver, opts: ProgressingEditsOptions): Promise<void> {

		// add decorations once per line that got edited
		const progress = new Progress<IValidEditOperation[]>(edits => {

			const newLines = new Set<number>();
			for (const edit of edits) {
				LineRange.fromRange(edit.range).forEach(line => newLines.add(line));
			}
			const existingRanges = this._progressiveEditingDecorations.getRanges().map(LineRange.fromRange);
			for (const existingRange of existingRanges) {
				existingRange.forEach(line => newLines.delete(line));
			}
			const newDecorations: IModelDeltaDecoration[] = [];
			for (const line of newLines) {
				newDecorations.push({ range: new Range(line, 1, line, Number.MAX_VALUE), options: this._decoInsertedText });
			}

			this._progressiveEditingDecorations.append(newDecorations);
		});
		return this._makeChanges(edits, obs, opts, progress);
	}

	private readonly _hunkDisplayData = new Map<HunkInformation, HunkDisplayData>();

	override async renderChanges(response: ReplyResponse) {

		if (response.untitledTextModel && !response.untitledTextModel.isDisposed()) {
			this._previewZone.value.showCreation(this._session.wholeRange.value.getStartPosition().delta(-1), response.untitledTextModel);
		} else {
			this._previewZone.value.hide();
		}

		this._progressiveEditingDecorations.clear();

		const renderHunks = () => {

			let widgetData: HunkDisplayData | undefined;

			changeDecorationsAndViewZones(this._editor, (decorationsAccessor, viewZoneAccessor) => {

				const keysNow = new Set(this._hunkDisplayData.keys());
				widgetData = undefined;

				for (const hunkData of this._session.hunkData.getInfo()) {

					keysNow.delete(hunkData);

					const hunkRanges = hunkData.getRangesN();
					let data = this._hunkDisplayData.get(hunkData);
					if (!data) {
						// first time -> create decoration
						const decorationIds: string[] = [];
						for (let i = 0; i < hunkRanges.length; i++) {
							decorationIds.push(decorationsAccessor.addDecoration(hunkRanges[i], i === 0
								? this._decoInsertedText
								: this._decoInsertedTextRange)
							);
						}

						const acceptHunk = () => {
							hunkData.acceptChanges();
							renderHunks();
						};

						const discardHunk = () => {
							hunkData.discardChanges();
							renderHunks();
						};

						// original view zone
						const mightContainNonBasicASCII = this._session.textModel0.mightContainNonBasicASCII();
						const mightContainRTL = this._session.textModel0.mightContainRTL();
						const renderOptions = RenderOptions.fromEditor(this._editor);
						const originalRange = hunkData.getRanges0()[0];
						const source = new LineSource(
							LineRange.fromRangeInclusive(originalRange).mapToLineArray(l => this._session.textModel0.tokenization.getLineTokens(l)),
							[],
							mightContainNonBasicASCII,
							mightContainRTL,
						);
						const domNode = document.createElement('div');
						domNode.className = 'inline-chat-original-zone2';
						const result = renderLines(source, renderOptions, [new InlineDecoration(new Range(originalRange.startLineNumber, 1, originalRange.startLineNumber, 1), '', InlineDecorationType.Regular)], domNode);
						const viewZoneData: IViewZone = {
							afterLineNumber: -1,
							heightInLines: result.heightInLines,
							domNode,
						};

						const toggleDiff = () => {
							const scrollState = StableEditorScrollState.capture(this._editor);
							changeDecorationsAndViewZones(this._editor, (_decorationsAccessor, viewZoneAccessor) => {
								assertType(data);
								if (!data.viewZoneId) {
									const [hunkRange] = hunkData.getRangesN();
									viewZoneData.afterLineNumber = hunkRange.startLineNumber - 1;
									data.viewZoneId = viewZoneAccessor.addZone(viewZoneData);
								} else {
									viewZoneAccessor.removeZone(data.viewZoneId!);
									data.viewZoneId = undefined;
								}
							});
							this._ctxCurrentChangeShowsDiff.set(typeof data?.viewZoneId === 'number');
							scrollState.restore(this._editor);
						};

						const remove = () => {
							changeDecorationsAndViewZones(this._editor, (decorationsAccessor, viewZoneAccessor) => {
								assertType(data);
								for (const decorationId of data.decorationIds) {
									decorationsAccessor.removeDecoration(decorationId);
								}
								if (data.viewZoneId) {
									viewZoneAccessor.removeZone(data.viewZoneId);
								}
								data.decorationIds = [];
								data.viewZoneId = undefined;
							});
						};

						const zoneLineNumber = this._zone.position!.lineNumber;
						const myDistance = zoneLineNumber <= hunkRanges[0].startLineNumber
							? hunkRanges[0].startLineNumber - zoneLineNumber
							: zoneLineNumber - hunkRanges[0].endLineNumber;

						data = {
							decorationIds,
							viewZoneId: '',
							viewZone: viewZoneData,
							distance: myDistance,
							position: hunkRanges[0].getStartPosition().delta(-1),
							acceptHunk,
							discardHunk,
							toggleDiff: !hunkData.isInsertion() ? toggleDiff : undefined,
							remove,
						};

						this._hunkDisplayData.set(hunkData, data);

					} else if (hunkData.getState() !== HunkState.Pending) {
						data.remove();

					} else {
						// update distance and position based on modifiedRange-decoration
						const zoneLineNumber = this._zone.position!.lineNumber;
						const modifiedRangeNow = hunkRanges[0];
						data.position = modifiedRangeNow.getStartPosition().delta(-1);
						data.distance = zoneLineNumber <= modifiedRangeNow.startLineNumber
							? modifiedRangeNow.startLineNumber - zoneLineNumber
							: zoneLineNumber - modifiedRangeNow.endLineNumber;
					}

					if (hunkData.getState() === HunkState.Pending && (!widgetData || data.distance < widgetData.distance)) {
						widgetData = data;
					}
				}

				for (const key of keysNow) {
					const data = this._hunkDisplayData.get(key);
					if (data) {
						this._hunkDisplayData.delete(key);
						data.remove();
					}
				}
			});

			if (widgetData) {
				this._zone.updatePositionAndHeight(widgetData.position);
				this._editor.revealPositionInCenterIfOutsideViewport(widgetData.position);

				const remainingHunks = this._session.hunkData.pending;
				this._updateSummaryMessage(remainingHunks);

				this._ctxCurrentChangeHasDiff.set(Boolean(widgetData.toggleDiff));
				this.toggleDiff = widgetData.toggleDiff;
				this.acceptHunk = async () => widgetData!.acceptHunk();
				this.discardHunk = async () => widgetData!.discardHunk();

			} else if (this._hunkDisplayData.size > 0) {
				// everything accepted or rejected
				let oneAccepted = false;
				for (const hunkData of this._session.hunkData.getInfo()) {
					if (hunkData.getState() === HunkState.Accepted) {
						oneAccepted = true;
						break;
					}
				}
				if (oneAccepted) {
					this._onDidAccept.fire();
				} else {
					this._onDidDiscard.fire();
				}
			}

			return widgetData;
		};

		return renderHunks()?.position;
	}

	protected _updateSummaryMessage(hunkCount: number) {
		let message: string;
		if (hunkCount === 0) {
			message = localize('change.0', "Nothing changed");
		} else if (hunkCount === 1) {
			message = localize('change.1', "1 change");
		} else {
			message = localize('lines.NM', "{0} changes", hunkCount);
		}
		this._zone.widget.updateStatus(message);
	}

	hasFocus(): boolean {
		return this._zone.widget.hasFocus();
	}

	override getWholeRangeDecoration(): IModelDeltaDecoration[] {
		// don't render the blue in live mode
		return [];
	}
}


async function undoModelUntil(model: ITextModel, targetAltVersion: number): Promise<void> {
	while (targetAltVersion < model.getAlternativeVersionId() && model.canUndo()) {
		await model.undo();
	}
}


function changeDecorationsAndViewZones(editor: ICodeEditor, callback: (accessor: IModelDecorationsChangeAccessor, viewZoneAccessor: IViewZoneChangeAccessor) => void): void {
	editor.changeDecorations(decorationsAccessor => {
		editor.changeViewZones(viewZoneAccessor => {
			callback(decorationsAccessor, viewZoneAccessor);
		});
	});
}
