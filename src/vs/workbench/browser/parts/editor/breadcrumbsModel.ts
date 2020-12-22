/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { DisposableStore, toDisposable } from 'vs/base/common/lifecycle';
import { isEqual, dirname } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { Schemas } from 'vs/base/common/network';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { BreadcrumbsConfig } from 'vs/workbench/browser/parts/editor/breadcrumbs';
import { FileKind } from 'vs/platform/files/common/files';
import { withNullAsUndefined } from 'vs/base/common/types';
import { IOutline, IOutlineService } from 'vs/workbench/services/outline/browser/outline';
import { IEditorPane } from 'vs/workbench/common/editor';

export class FileElement {
	constructor(
		readonly uri: URI,
		readonly kind: FileKind
	) { }
}

type FileInfo = { path: FileElement[], folder?: IWorkspaceFolder };

export class OutlineElement2 {
	constructor(
		readonly element: IOutline<any> | any,
		readonly outline: IOutline<any>
	) { }
}

export class BreadcrumbsModel {

	private readonly _disposables = new DisposableStore();
	private readonly _fileInfo: FileInfo;

	private readonly _cfgEnabled: BreadcrumbsConfig<boolean>;
	private readonly _cfgFilePath: BreadcrumbsConfig<'on' | 'off' | 'last'>;
	private readonly _cfgSymbolPath: BreadcrumbsConfig<'on' | 'off' | 'last'>;

	private _currentOutline?: IOutline<any>;
	private readonly _outlineDisposables = new DisposableStore();


	private readonly _onDidUpdate = new Emitter<this>();
	readonly onDidUpdate: Event<this> = this._onDidUpdate.event;

	constructor(
		fileInfoUri: URI,
		editor: IEditorPane | undefined,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
		@IOutlineService private readonly _outlineService: IOutlineService,
	) {
		this._cfgEnabled = BreadcrumbsConfig.IsEnabled.bindTo(configurationService);
		this._cfgFilePath = BreadcrumbsConfig.FilePath.bindTo(configurationService);
		this._cfgSymbolPath = BreadcrumbsConfig.SymbolPath.bindTo(configurationService);

		this._disposables.add(this._cfgFilePath.onDidChange(_ => this._onDidUpdate.fire(this)));
		this._disposables.add(this._cfgSymbolPath.onDidChange(_ => this._onDidUpdate.fire(this)));
		this._fileInfo = BreadcrumbsModel._initFilePathInfo(fileInfoUri, workspaceService);

		if (editor) {
			this._bindToEditor(editor);
			this._disposables.add(_outlineService.onDidChange(() => this._bindToEditor(editor)));
		}
		this._onDidUpdate.fire(this);
	}

	dispose(): void {
		this._cfgEnabled.dispose();
		this._cfgFilePath.dispose();
		this._cfgSymbolPath.dispose();
		this._outlineDisposables.dispose();
		this._disposables.dispose();
		this._onDidUpdate.dispose();
	}

	isRelative(): boolean {
		return Boolean(this._fileInfo.folder);
	}

	getElements(): ReadonlyArray<FileElement | OutlineElement2> {
		let result: (FileElement | OutlineElement2)[] = [];

		// file path elements
		if (this._cfgFilePath.getValue() === 'on') {
			result = result.concat(this._fileInfo.path);
		} else if (this._cfgFilePath.getValue() === 'last' && this._fileInfo.path.length > 0) {
			result = result.concat(this._fileInfo.path.slice(-1));
		}

		if (this._cfgSymbolPath.getValue() === 'off') {
			return result;
		}

		if (!this._currentOutline) {
			return result;
		}

		let didAddOutlineElement = false;
		for (let element of this._currentOutline.breadcrumbsConfig.breadcrumbsDataSource.getBreadcrumbElements()) {
			result.push(new OutlineElement2(element, this._currentOutline));
			didAddOutlineElement = true;
		}
		if (!didAddOutlineElement && !this._currentOutline.isEmpty) {
			result.push(new OutlineElement2(this._currentOutline, this._currentOutline));
		}

		return result;
	}

	private static _initFilePathInfo(uri: URI, workspaceService: IWorkspaceContextService): FileInfo {

		if (uri.scheme === Schemas.untitled) {
			return {
				folder: undefined,
				path: []
			};
		}

		let info: FileInfo = {
			folder: withNullAsUndefined(workspaceService.getWorkspaceFolder(uri)),
			path: []
		};

		let uriPrefix: URI | null = uri;
		while (uriPrefix && uriPrefix.path !== '/') {
			if (info.folder && isEqual(info.folder.uri, uriPrefix)) {
				break;
			}
			info.path.unshift(new FileElement(uriPrefix, info.path.length === 0 ? FileKind.FILE : FileKind.FOLDER));
			let prevPathLength = uriPrefix.path.length;
			uriPrefix = dirname(uriPrefix);
			if (uriPrefix.path.length === prevPathLength) {
				break;
			}
		}

		if (info.folder && workspaceService.getWorkbenchState() === WorkbenchState.WORKSPACE) {
			info.path.unshift(new FileElement(info.folder.uri, FileKind.ROOT_FOLDER));
		}
		return info;
	}

	private _bindToEditor(editor: IEditorPane): void {
		const newCts = new CancellationTokenSource();

		this._outlineDisposables.clear();
		this._outlineDisposables.add(toDisposable(() => newCts.dispose(true)));

		this._outlineService.createOutline(editor, newCts.token).then(outline => {
			if (newCts.token.isCancellationRequested) {
				// cancelled: dispose new outline and reset
				outline?.dispose();
				outline = undefined;
			}
			this._currentOutline = outline;
			this._onDidUpdate.fire(this);
			if (outline) {
				this._outlineDisposables.add(outline);
				this._outlineDisposables.add(outline.onDidChange(() => this._onDidUpdate.fire(this)));
				this._outlineDisposables.add(outline.onDidChangeActive(() => this._onDidUpdate.fire(this)));
			}

		}).catch(err => {
			this._currentOutline = undefined;
			this._onDidUpdate.fire(this);
			onUnexpectedError(err);
		});
	}

}
