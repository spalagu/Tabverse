export const STR = {
  common: {
    appName: "Tabverse",
    dismiss: "Dismiss",
    cancel: "Cancel",
    retry: "Try again",
    details: "Details",
    close: "Close",
    closeHint: (p: { keys: string }) => `Close (${p.keys})`,
    // Empty content area (TabContent)
    placeholderBlurb: "This tab type isn't available yet.",
    noTabsTitle: "No tabs",
    noTabsHint: (p: { keys: string }) =>
      `Press ${p.keys} to open a terminal.`,
    allAsleepTitle: "Everything is asleep",
    allAsleepHint: (p: { keys: string }) =>
      `Click a pinned tab to wake it, or press ${p.keys} for a terminal.`,
    // Split panes and their corner controls
    dragResizeSplit: "Drag to resize the split",
    splitOptions: "Split options",
    closeTabHint: (p: { keys: string }) => `Close this tab (${p.keys})`,
    removePaneHint: "Remove this pane from the split",
    closePane: "Close pane",
    splitAddDisabledHint: "No other tab to add, or the split is full.",
    splitMenu: {
      moveUp: "Move up",
      moveDown: "Move down",
      moveLeft: "Move left",
      moveRight: "Move right",
      separate: "Separate tab from split",
      addAbove: "Add split above",
      addBelow: "Add split below",
      addLeft: "Add left split",
      addRight: "Add right split",
      toHorizontal: "Convert to horizontal split view",
      toVertical: "Convert to vertical split view",
    },
    // Peek overlay controls
    peekClose: "Close peek",
    peekOpenAsTab: "Open as tab",
    peekSplitAria: "Split with source tab",
    peekSplitHint: (p: { title: string }) => `Split beside ${p.title}`,
    // Sidebar
    sidebar: {
      deviationHint: "Away from its pinned page — click again to go back",
      attentionHint: "New output",
      mutedHint: "Muted — click to unmute",
      audibleHint: "Making sound — click to mute",
      viewersHint: "Viewers on this session",
      sharingHint: (p: { viewers: number }) =>
        `Sharing — ${plural(p.viewers, "viewer")}. Click to manage`,
      shareHint: "Share this tab (remote control)",
      appShareHint: "Share the whole app (remote control)",
      appSharingHint: (p: { viewers: number }) =>
        `Sharing the whole app — ${plural(p.viewers, "viewer")}`,
      shareNeedsOnePane:
        "Sharing needs a single terminal — close the other panes first",
      shareNeedsNoBroadcast:
        "Turn off broadcast input before sharing this terminal",
      closeTab: "Close tab",
      deleteGroupHint: "Delete this group",
      closeGroupHint: "Close every tab in this group — they stay here, asleep",
      todayZone: "Today",
      archivedHint: "Archived tabs",
      archiveTodayHint: "Archive every today tab that can be put away",
      clear: "Clear",
      unpinHint: (p: { keys: string }) => `Unpin the sidebar (${p.keys})`,
      pinHint: (p: { keys: string }) => `Pin the sidebar (${p.keys})`,
      broadcastHint:
        "Broadcast input is on — typing goes to every pane of this terminal",
      remoteHint: (p: { host: string }) =>
        `Remote session on ${p.host} — the pane left it when the command ends`,
      profileBadgeHint: (p: { name: string }) =>
        `Opened under the “${p.name}” profile`,
      newTabHint: (p: { keys: string }) => `New tab (${p.keys})`,
      searchHint: (p: { keys: string }) =>
        `Search tabs and commands (${p.keys})`,
      dragResizeHint: "Drag to resize",
      settings: "Settings",
      backgroundTasksHint: (p: { count: number }) =>
        p.count === 1
          ? "1 terminal task running in the background"
          : `${p.count} terminal tasks running in the background`,
    },
    // Tab right-click menu
    tabMenu: {
      splitWithActive: "Split with active tab",
      unsplit: "Unsplit",
      pin: "Pin",
      unpin: "Unpin",
      updatePinnedAddress: "Update pinned address",
      duplicate: "Duplicate",
      rename: "Rename",
      mute: "Mute tab",
      unmute: "Unmute",
      scriptCommands: "Script commands",
      saveLayout: "Save layout as template…",
      residentPolicy: "Keep running",
      residentInherit: "Use app default",
      residentOn: "Always",
      residentOff: "Never",
      pickedTabs: (p: { n: number }) => plural(p.n, "tab"),
      closeBatch: (p: { n: number }) => `Close — ${plural(p.n, "tab")}`,
      archiveBatch: (p: { acting: number; total: number }) =>
        p.acting < p.total
          ? `Archive — ${p.acting} of ${p.total} tabs`
          : `Archive — ${plural(p.acting, "tab")}`,
      muteBatch: (p: { acting: number; total: number }) =>
        p.acting < p.total
          ? `Mute — ${p.acting} of ${p.total} tabs`
          : `Mute — ${plural(p.acting, "tab")}`,
      unmuteBatch: (p: { acting: number; total: number }) =>
        p.acting < p.total
          ? `Unmute — ${p.acting} of ${p.total} tabs`
          : `Unmute — ${plural(p.acting, "tab")}`,
      batchNotIncluded: (p: { names: string }) => `Not included: ${p.names}`,
      closeFinalAsk: (p: { title: string }) =>
        `Close “${p.title}”? It will not be in the reopen list.`,
    },
    // Sidebar-background and folder-header menus
    sidebarMenu: {
      newGroup: "New group",
      reopenNone: "Reopen closed tab — none",
      reopenCount: (p: { count: number }) =>
        `Reopen closed tab (${p.count})`,
      newNestedFolder: "New nested folder",
      deleteFolder: "Delete folder…",
    },
    // ⌘P switcher
    switcher: {
      placeholder: "Switch to tab…",
      empty: "No matching tabs",
      hintChoose: (p: { arrows: string; cmdArrows: string }) =>
        `${p.arrows} or ${p.cmdArrows} to choose`,
    },
    hints: {
      go: (p: { keys: string }) => `${p.keys} go`,
      pick: (p: { keys: string }) => `${p.keys} pick`,
      choose: (p: { keys: string }) => `${p.keys} choose`,
      run: (p: { keys: string }) => `${p.keys} run`,
      open: (p: { keys: string }) => `${p.keys} open`,
      complete: (p: { keys: string }) => `${p.keys} complete`,
      clear: (p: { keys: string }) => `${p.keys} clear`,
      close: (p: { keys: string }) => `${p.keys} close`,
    },
    // The command bar's core rows (shared with the new-tab page)
    bar: {
      placeholder: "Tabs, commands, history — or a URL / search",
      sectionTabs: "Open tabs",
      sectionHistory: "History",
      sectionCommands: "Commands",
      sectionProfiles: "Terminal profiles",
      sectionClosed: "Recently closed — this session",
      sectionArchived: "Archive",
      newUnderProfile: (p: { name: string }) =>
        `New terminal under “${p.name}”`,
      openUrl: (p: { url: string }) => `Open ${p.url}`,
      searchFor: (p: { engine: string; query: string }) =>
        `Search ${p.engine} for “${p.query}”`,
      yourSearchEngine: "your search engine",
    },
    proceed: "Continue",
    help: {
      filterPlaceholder: "Filter shortcuts",
      title: "Keyboard shortcuts",
      sectionTabs: "Tabs",
      sectionTerminal: "Terminal",
      sectionFiles: "Files",
      sectionBrowser: "Browser",
      sectionWindow: "Window",
    },
  },
  term: {
    exitedLine: (p: { code: number; keys: string }) =>
      `Process exited with code ${p.code} — press ${p.keys} to close.`,
    exitedLineNoCode: (p: { keys: string }) =>
      `Process exited — press ${p.keys} to close.`,
    startingShell: "Starting the shell…",
    backgroundCloseAsk: (p: { title: string }) =>
      `“${p.title}” still has a command running. What should happen when this tab closes?`,
    backgroundKeepRunning: "Close tab and keep task running",
    backgroundStopTask: "Stop task and close tab",
    backgroundDetachFailed:
      "The task could not be moved to the background. The tab stayed open.",
    backgroundQuitAsk: (p: { count: number }) =>
      p.count === 1
        ? "One terminal task is still running. What should happen when Tabverse quits?"
        : `${p.count} terminal tasks are still running. What should happen when Tabverse quits?`,
    backgroundQuitKeep: "Quit and keep terminal tasks running",
    backgroundQuitStop: "Stop all terminal tasks and quit",
    backgroundQuitFailed:
      "Tabverse could not finish changing terminal task ownership. The app stayed open.",
    panelExitedLine: "Shell exited — reopen the panel for a new one.",
    broadcasting: (p: { count: number; keys: string }) =>
      `Broadcasting to ${plural(p.count, "pane")} — press ${p.keys} to stop`,
    broadcastOnItem: "Type into every pane",
    broadcastOffItem: "Stop typing into every pane",
    openCwdInFiles: "Open this directory in a files pane",
    remoteHostHint: (p: { host: string }) => `Remote session on ${p.host}`,
    pullFrom: (p: { host: string }) => `Pull from ${p.host}`,
    /** Why the pull item is greyed: it acts on the path under the pointer. */
    pullNeedsPath:
      "Hover a file path in this pane's output first, then right-click to pull it",
    transferring: "Transferring…",
    uploadTitle: (p: { host: string }) => `Upload to ${p.host}`,
    uploadDestLabel: "Destination (host:directory)",
    uploadSubmit: "Upload",
    uploadNote: (p: { count: number }) =>
      `Dropped ${plural(p.count, "file")} — sent with the system scp`,
    uploadDone: (p: { count: number; host: string }) =>
      `Uploaded ${plural(p.count, "file")} to ${p.host}`,
    /** The honest ceiling of the drag-and-drop upload: the file's bytes
     *  travel through the interface, so a big one belongs in scp proper. */
    uploadTooLarge: (p: { mb: number }) =>
      `${p.mb} MB is over the drop upload limit — run scp in the terminal for large files`,
    demoNoTransfer:
      "The browser demo cannot run scp — file transfers are a desktop-app feature",
    openCwdFallback: (p: { dir: string }) =>
      `Couldn't open ${p.dir} — starting in the default directory.`,
    completionFlagsTitle: (p: { command: string }) =>
      `${p.command} flags`,
    completionPickHint: (p: { keys: string }) =>
      `Press ${p.keys} to complete, Escape to dismiss`,
    pasteTitle: (p: { count: number }) =>
      `Paste ${plural(p.count, "line")}?`,
    pasteNote:
      "Multi-line text pastes as one block — nothing runs until you press " +
      "Return in the terminal. Edit below to change what gets sent; Enter " +
      "pastes, Escape cancels.",
    pasteSubmit: "Paste",
    // Block bar
    statusRunning: "Running",
    statusOk: "OK",
    statusExit: (p: { code: number }) => `Exit ${p.code}`,
    copyCommand: "Copy command",
    copyCommandHint: "Copy the command",
    copyOutput: "Copy output",
    copyOutputHint: "Copy only this command's output",
    copied: "Copied",
    rerun: "Rerun",
    rerunHint: "Run this command again",
    rerunWaitHint: "Wait for the running command to finish",
    prevBlockHint: (p: { keys: string }) => `Previous block (${p.keys})`,
    nextBlockHint: (p: { keys: string }) => `Next block (${p.keys})`,
    findHint: (p: { keys: string }) => `Find in terminal (${p.keys})`,
    // Find bar
    findPlaceholder: "Find in terminal…",
    matchCase: "Aa",
    matchCaseHint: "Match case",
    wholeWordHint: "Whole word",
    regexHint: "Regular expression",
    historyHint: (p: { keys: string }) =>
      `Find in terminal — ${p.keys} recalls a previous search`,
    prevMatchHint: (p: { keys: string }) => `Previous (${p.keys})`,
    nextMatchHint: (p: { keys: string }) => `Next (${p.keys})`,
  },
  errors: {
    actions: {
      // Browser
      showPage: "show this page",
      openPage: "open the page",
      pullFile: "pull the file over scp",
      pushFile: "push the file over scp",
      // Files: editor
      openFile: "open the file",
      saveFile: "save the file",
      formatJson: "format the file as JSON",
      // Files: tree and panels
      readFolder: "read the folder",
      applyFileChange: "make that change",
      copyFilesOut: "copy the files to the clipboard",
      searchFiles: "search these files",
      replaceInFiles: "replace in these files",
      readChanges: "read the changes",
      compressItems: "compress the items",
      extractArchive: "extract the archive",
      saveExcludeList: "save the excluded-folders list",
      // Files: preview family
      previewFile: "preview the file",
      readFile: "read the file",
      loadFont: "load the font",
      inspectFile: "inspect the file",
      openDatabase: "open the database",
      readTable: "read the table",
      readNotebook: "read the notebook",
      // Settings
      setDefaultApp: "change the default app",
      exportPasswords: "export the passwords",
      importPasswords: "import the passwords",
      showPasswords: "open the password list",
      forgetLogins: "forget the saved logins",
      forgetSession: "forget the saved session",
      clearHistory: "clear the browsing history",
      restoreDefaults: "restore the factory settings",
      changeKey: "save that key",
      exportBackup: "export the backup",
      importBackup: "import the backup",
      installScript: "install the script",
      updateScript: "update the script",
      checkScriptUpdate: "check the script for updates",
      removeScript: "remove the script",
      revokeGrant: "revoke the script's access",
      updateCompletions: "update the completion spec",
      // Passwords panel
      readLogins: "read the saved logins",
      revealPassword: "show the password",
      copyPassword: "copy the password",
      deleteLogin: "delete the login",
      // Sharing and remote
      startSharing: "start sharing",
      kickViewer: "remove the viewer",
      setViewerAccess: "change the viewer's access",
      joinSession: "join the shared tab",
      connect: "connect",
      // Downloads
      openDownload: "open the download",
      revealDownload: "show the download in the Finder",
      openInFiles: "show the download in a files tab",
      // Terminal
      startShell: "start the shell",
      saveProfile: "save the profile",
      removeProfile: "remove the profile",
      saveLayout: "save the layout",
      removeLayout: "remove the layout",
    },
  },
  files: {
    view: {
      terminalToggle: "Terminal",
      hideShellHint: (p: { keys: string }) =>
        `Hide the shell for this directory (${p.keys})`,
      openShellHint: (p: { keys: string }) =>
        `Open a shell in this directory (${p.keys})`,
      jumpPlaceholder: "Jump to directory…",
      parentDirHint: "Go to parent directory",
      modeFiles: "Files",
      modeFilesHint: "Directory tree",
      modeFind: "Find",
      modeFindHint: "Search and replace across this directory",
      modeChanges: "Changes",
      modeChangesHint: "Files version control says have changed",
      hideDotfilesHint: "Hide dotfiles",
      showDotfilesHint: "Show dotfiles",
      closeFile: "Close file",
      dirtyConflictHint:
        "Unsaved draft, and the file changed on disk — open it to decide",
      dirtyCloseHint: "Unsaved — click to close",
      missingChip: "Missing on disk",
      missingFileHint:
        "This file no longer exists on disk; it stays open here until you close it",
      noFileTitle: "No file open",
      noFileBlurb: (p: {
        quickOpenKeys: string;
        locationKeys: string;
        terminalKeys: string;
      }) =>
        `Click a file in the tree, or press ${p.quickOpenKeys} to open by name. Right-click the tree for new file, rename and trash. ${p.locationKeys} jumps to a directory, ${p.terminalKeys} opens a shell in it.`,
      truncatedSuffix: " · truncated",
      unsavedHint: "Unsaved changes",
      modePreview: "Preview",
      modeSplit: "Split",
      modeSource: "Source",
      modeDetails: "Details",
      backToRenderedHint: "Back to the rendered view",
      showSourceHint: "Show the raw source",
      formatJson: "Format",
      formatJsonHint: (p: { keys: string }) =>
        `Pretty-print this JSON (edits the draft; ${p.keys} saves)`,
      diff: "Diff",
      diffHint: "Toggle diff against git HEAD",
      save: "Save",
      saving: "Saving…",
      saveHint: (p: { keys: string }) => `Save (${p.keys})`,
      readOnlyChip: "Read-only",
      reveal: "Reveal",
      revealHint: "Reveal in Finder",
      closeCompare: "Close the comparison",
      compareTabHint: (p: { a: string; b: string }) =>
        `Compare ${p.a} (editable) with ${p.b} (read-only)`,
      compareSides: "Left is editable · right is the original",
      compareSnapshotChip: "Snapshot",
      compareSnapshotHint: (p: { name: string }) =>
        `The right side is ${p.name} as it was when the comparison opened — reopen it to pick up disk changes`,
      comparePickerPlaceholder: "Compare with a file…",
      /** Only text files compare (canDiff's rule). */
      compareTextOnly: "Only text files can be compared.",
      conflictTail:
        " was changed on disk while your unsaved draft was stored. Left " +
        "is the file as it is now, right is your draft — nothing has been " +
        "overwritten.",
      keepDraft: "Keep my draft",
      keepDraftHint:
        "Dismiss this and keep editing your draft; the file on disk stays " +
        "as it is until you save",
      discardDraft: "Discard my draft",
      discardDraftHint:
        "Throw the stored draft away and edit the file as it is on disk",
      restoring: "Restoring the workspace…",
    },
    /** The strip above the tree that orders and shapes the listing. */
    sortBar: {
      sortHint: "Sort order",
      keyName: "Name",
      keyKind: "Type",
      keySize: "Size",
      keyModified: "Date",
      ascending: "Ascending",
      descending: "Descending",
      dirsFirst: "Folders first",
      dirsFirstHint: "Keep folders above files in every sort order",
    },
    panes: {
      dual: "Dual",
      dualHint: "Show a second directory window; Tab switches between them",
      layoutRow: "Side by side",
      layoutColumn: "Stacked",
      layoutHint: "Flip the two windows between side by side and stacked",
    },
    viewSwitch: {
      tree: "Tree",
      columns: "Columns",
      hint: "How this directory is listed, per pane",
    },
    pathBar: {
      jumpHint: (p: { dir: string }) => `Jump to ${p.dir}`,
      paneHint: (p: { n: number }) => `Directory window ${p.n}`,
      branchHint: "The branch this directory's repository is on",
    },
    loc: {
      completionHint: (p: { keys: string }) => `Folder — ${p.keys} completes`,
    },
    nav: {
      backHint: "Back to the previous directory",
      forwardHint: "Forward again",
    },
    filter: {
      blankQuery: "·",
      count: (p: { shown: number; total: number }) =>
        `${p.shown} of ${p.total}`,
      all: "All",
      dirs: "Folders",
      files: "Files",
      kindHint: "Show only folders, only files, or everything",
      clearHint: "Esc clears the filter",
    },
    quickOpen: {
      placeholder: "Open file by name…",
      indexing: "Indexing…",
      empty: "No matching files",
      indexFailed: "Couldn't index this folder.",
    },
    demoTitle: "Files",
    demoBlurb:
      "The explorer needs the desktop app — the browser demo has no " +
      "filesystem access.",
    // Shared by the preview family
    viewers: {
      loading: (p: { name: string }) => `Loading ${p.name}…`,
      loadingTail: (p: { name: string }) => `Loading the end of ${p.name}…`,
      reading: (p: { name: string }) => `Reading ${p.name}…`,
      inspecting: (p: { name: string }) => `Inspecting ${p.name}…`,
      converting: (p: { name: string }) => `Converting ${p.name}…`,
    },
    hex: {
      position: (p: { offset: string; total: string }) =>
        `Offset 0x${p.offset} · ${p.total} bytes total`,
      start: "⤒ Start",
      prev: "‹ Previous",
      next: "Next ›",
      end: "⤓ End",
      firstPageHint: "First page",
      prevPageHint: "Previous 4 KiB",
      nextPageHint: "Next 4 KiB",
      lastPageHint: "Last page",
      jumpPlaceholder: "0x0 or 1234",
      jumpHint: "Jump to offset — hex (0x…) or decimal, clamped to the file",
      emptyFile: "Empty file — no bytes to dump.",
    },
    log: {
      range: (p: { lo: string; hi: string; total: string; position: string }) =>
        `Viewing bytes ${p.lo}–${p.hi} of ${p.total} · ${p.position}`,
      capTrimmedSuffix: " · newest end dropped to stay under 2 MiB",
      jumpStartHint: "Jump to the start of the file",
      jumpEndHint: "Jump to the end of the file",
      loadEarlier: "Load 256 KiB earlier",
      refresh: "⟳ Refresh",
      refreshHint: "Re-read the size and reload the tail — the file may have grown",
      emptyFile: "Empty file.",
    },
    csv: {
      info: (p: { rows: number; cols: number }) =>
        `${p.rows} rows × ${p.cols} cols`,
      truncationNote: (p: { shown: number; total: number }) =>
        `Showing first ${p.shown} of ${p.total} rows`,
      editAsSourceNote: "Files beyond the limit are edited as source",
      emptyFile: "Empty file — nothing to tabulate.",
      insertRow: "Insert row above",
      deleteRow: "Delete row",
      insertColumn: "Insert column left",
      deleteColumn: "Delete column",
      blockedTruncated:
        "Only files within the row limit can be edited as a grid — this one is truncated, so it is edited as source",
      blockedNoEdit: "This file cannot be edited",
      rowHead: "Row numbers",
      rowTitle: (p: { n: number }) => `Row ${p.n}`,
      colTitle: (p: { name: string }) => `Column ${p.name}`,
      colNumber: (p: { n: number }) => `#${p.n}`,
    },
    inspect: {
      keyWarningLead: "This file contains a",
      keyWarningTail: ". Key material is never displayed.",
      archiveTruncated: (p: { total: number; shown: number }) =>
        `${p.total} entries · showing first ${p.shown}`,
      archiveCount: (p: { total: number }) =>
        plural(p.total, "entry", "entries"),
      colPath: "Path",
      colSize: "Size",
      extractHere: "Extract here",
      extractTo: "Extract to…",
      extracting: "Extracting…",
      extractDone: (p: { n: number; dir: string }) =>
        `Extracted ${plural(p.n, "file")} to ${p.dir}`,
      extractPickHint: "Choose a folder to extract into",
      exec: {
        formatMachO: "Mach-O binary",
        formatElf: "Unix executable",
        formatPe: "Windows executable",
        formatScript: "Script",
        /** A fat/universal binary holds more than one architecture. */
        universal: "Universal",
        execBitOn: "Executable",
        execBitOff: "Not executable",
        execBitHint: "The file's permission bits allow running it",
        execBitOffHint:
          "No execute permission on the file (Windows has no such bit)",
        fieldArchs: "Architectures",
        fieldInterpreter: "Interpreter",
        fieldSignature: "Code signature",
        fieldEntry: "Entry point",
        fieldDylibs: "Linked libraries",
        /**
         * The signature answers are byte-level facts from the header — a
         * presence report, never a codesign verdict.
         */
        signedYes: "Signature segment present — a header fact, not a verdict",
        signedNo: "No signature segment in the header",
        entryNote: "The loader jumps straight to the program's main",
        dylibCountLabel: (p: { n: number }) =>
          plural(p.n, "load command", "load commands"),
        /** One architecture row: name, width, role where stated. */
        archRow: (p: { arch: string; bits: number; fileType: string | null }) =>
          `${p.arch} · ${p.bits}-bit${p.fileType ? ` · ${p.fileType}` : ""}`,
      },
      nothingToInspect: "Nothing to inspect in this file.",
      expiredToday: "Expired today",
      expiredAgo: (p: { days: number }) =>
        `Expired ${plural(p.days, "day")} ago`,
      expiresIn: (p: { days: number }) => `Expires in ${plural(p.days, "day")}`,
      validUntil: (p: { date: string }) => `Valid until ${p.date}`,
      csrPill: "Signing request",
      caPill: "CA",
      csrNote:
        "This is a certificate signing request — it has not been signed " +
        "by an authority and carries no validity period.",
      fieldSubject: "Subject",
      fieldIssuer: "Issuer",
      fieldSans: "SANs",
      fieldValidity: "Validity",
      fieldSerial: "Serial",
      fieldSignature: "Signature",
      fieldKey: "Key",
      fieldSha256: "SHA-256",
    },
    sqlite: {
      notDatabase: "This file could not be read as a SQLite database.",
      emptyDatabase: "Empty database — no tables to show.",
      pagerRange: (p: { first: number; last: number; total: number }) =>
        `Rows ${p.first}–${p.last} of ${p.total}`,
    },
    font: {
      notFont: "The file did not decode as a usable font.",
      glyphCount: (p: { n: number }) => `${p.n} glyphs`,
      variable: "Variable",
      static: "Static",
    },
    preview: {
      imageCaption: (p: { w: number; h: number; size: string }) =>
        `${p.w} × ${p.h} px · ${p.size}`,
      rendered: "Rendered",
      source: "Source",
      pptxNote:
        "No in-app .pptx viewer yet — use Reveal in Finder to open it in " +
        "Keynote.",
      legacyOfficeNote:
        "Legacy .doc/.ppt formats have no in-app viewer yet — open in Finder.",
    },
    html: {
      staticNote: "Static preview — scripts off",
      fallbackNote:
        " · too large to carry an address, so its own links will not jump",
      openInBrowser: "Open in browser tab",
    },
    notebook: {
      inBadge: (p: { n: string }) => `In [${p.n}]`,
      outputTruncated: "Output truncated",
      outputAlt: "Notebook output",
    },
    changes: {
      reading: "Reading…",
      notRepo: "This directory is not inside a version-controlled repository.",
      clean: "Nothing has changed here.",
      group: {
        conflicted: "Conflicted",
        deleted: "Deleted",
        modified: "Modified",
        renamed: "Renamed",
        added: "Added",
        untracked: "Untracked",
        ignored: "Ignored",
      },
    },
    search: {
      searchPlaceholder: "Search",
      replacePlaceholder: "Replace",
      matchCaseGlyph: "Aa",
      matchCaseHint: "Match case",
      wholeWordGlyph: "ab",
      wholeWordHint: "Whole word",
      regexGlyph: ".*",
      regexHint: "Regular expression",
      replaceAllHint: "Replace in every matching file",
      replaceInFileHint: "Replace in this file",
      replaceLabel: "Replace",
      globRowLabel: "Globs",
      includePlaceholder: "Include (e.g. **/*.rs)",
      excludePlaceholder: "Exclude (e.g. **/*.log)",
      globGhostHint: "Tab — match in every directory, not just the top level",
      excludesRowLabel: "Excluded folders",
      excludesRowHint:
        "Folders search, quick-open and the tree's watcher all skip. " +
        "Saved in config.toml, not per search",
      excludesPlaceholder: "Folder-name globs, comma-separated (vendor, *-generated)",
      excludesGitignore: ".gitignore",
      excludesGitignoreHint:
        "Let .gitignore files remove entries from search and quick-open",
      excludesRestore: "Reset",
      excludesRestoreHint:
        "Restore the default exclude list (the built-ins alone, .gitignore off)",
      excludesNote:
        "Applies to search, quick-open and the files tab's watcher.",
      modeHint: "Search by contents or by file name",
      modeContent: "Content",
      modeName: "Name",
      namePlaceholder: "File name glob",
      nameEmpty: "No files match.",
      nameResultLine: (p: { files: number }) => `${plural(p.files, "file")}`,
      selectInTree: (p: { n: number }) => `Select ${p.n} in tree`,
      selectInTreeHint: "Hand the picked files to the tree's selection",
      previewHeader: (p: { query: string; replacement: string }) =>
        `Replace “${p.query}” with “${p.replacement}”`,
      previewScope: (p: { files: number; places: number }) =>
        `${p.places} in ${plural(p.files, "file")} will change`,
      previewNothing: "Nothing to replace.",
      previewCancel: "Cancel",
      previewNoUndo: "There is no undo.",
      previewFailed: (p: { names: string }) => `Failed: ${p.names}`,
      previewFileCheckHint: "Replace every place in this file",
      previewSiteCheckHint: "Replace this place",
      scopeAll: (p: { files: number; places: number }) =>
        `all ${p.files} files (${p.places} places)`,
      replaceQuestion: (p: {
        query: string;
        replacement: string;
        scope: string;
      }) =>
        `Replace every “${p.query}” with “${p.replacement}” in ${p.scope}? There is no undo.`,
      replacedResult: (p: { count: number; files: number }) =>
        `Replaced ${p.count} in ${plural(p.files, "file")}.`,
      searching: "Searching…",
      resultLine: (p: { hits: number; files: number }) =>
        `${p.hits} in ${plural(p.files, "file")}`,
      truncatedSuffix: (p: { max: number }) =>
        ` — stopped at ${p.max}, there are more`,
      pressEnter: "Press Enter to search",
    },
    previewFind: {
      placeholder: "Find in preview",
      isolatedPlaceholder: "Search the source instead",
      isolatedNote:
        "This preview is an isolated frame — nothing outside it can read it.",
      prevMatchHint: "Previous match",
      nextMatchHint: "Next match",
      searchSourceHint: "Search the source, where it can also be replaced",
      inSource: "In source",
    },
    termPanel: {
      gripHint: "Drag to resize · double-click for the default height",
      hideHint: "Hide the terminal panel",
    },
    editorTabMenu: {
      close: "Close",
      closeOthers: "Close others",
      closeRight: "Close to the right",
      closeAll: "Close all",
      compareWith: "Compare with…",
      copyPath: "Copy path",
      copyRelativePath: "Copy relative path",
    },
    tree: {
      newNamePlaceholder: (p: { kind: string }) => `Name of the new ${p.kind}…`,
      containsBadgeHint: (p: { status: string }) =>
        `Contains ${p.status} files`,
      newFile: "New file…",
      newFolder: "New folder…",
      pasteInto: (p: { dir: string }) => `Paste into ${p.dir}`,
      pasteEmpty: "Paste — nothing copied",
      rename: "Rename…",
      openAsRoot: "Open as root",
      copy: "Copy",
      cut: "Cut",
      copyPath: "Copy path",
      copyRelativePath: "Copy relative path",
      copyToClipboard: "Copy to clipboard",
      revealInFinder: "Reveal in Finder",
      moveToTrash: "Move to Trash",
      compressZip: "Compress to Zip",
      compressTgz: "Compress to .tgz",
      /** The note while the backend packs or unpacks (synchronous pass). */
      packing: (p: { n: number; format: string }) =>
        `Compressing ${plural(p.n, "item")} to ${p.format}…`,
      withCount: (p: { label: string; n: number }) =>
        p.n > 1 ? `${p.label} — ${plural(p.n, "item")}` : p.label,
      dragCount: (p: { n: number }) => plural(p.n, "item"),
      batchFailed: (p: { failed: number; total: number; first: string }) =>
        `${p.failed} of ${plural(p.total, "item")} failed — ${p.first}`,
      batchReport: (p: { added: number; skipped: number; failed: number }) =>
        `Transferred ${p.added} — skipped ${p.skipped}, failed ${p.failed}.`,
      conflictAsk: (p: { clashes: number; total: number; dir: string }) =>
        `${p.clashes} of ${plural(p.total, "item")} already exist in “${p.dir}”. What happens to them?`,
      conflictSkip: "Skip",
      conflictKeepBoth: "Keep both",
      /** Finder's own word; the danger flag is set at the call site. */
      conflictReplace: "Replace",
      compare: "Compare",
      emptyFolder: "Empty folder",
      readingFolder: "Reading the folder…",
      undoTrashHonest: (p: { path: string }) =>
        `“${p.path}” is in the Trash — undo cannot bring it back automatically.`,
      undoReplaceHonest: (p: { path: string }) =>
        `“${p.path}” was replaced on purpose — undo cannot bring back what was there before.`,
    },
  },
  browser: {
    // The blank new-tab page
    newTab: {
      placeholder: "Search or enter address",
      emptyBlurb: "Sites you visit will show up here.",
    },
    // The desktop-only notice the browser demo shows instead of a webview
    demoTitle: "Browser",
    demoBlurb:
      "Browser tabs embed a real webview, which only exists in the " +
      "desktop app — the browser demo cannot nest one.",
    // ⌘L address bar
    addressPlaceholder: "Enter a URL or search…",
    hintReload: (p: { keys: string }) => `${p.keys} reload`,
    hintBack: (p: { keys: string }) => `${p.keys} back`,
    hintForward: (p: { keys: string }) => `${p.keys} forward`,
    hintZoom: (p: { keys: string }) => `${p.keys} zoom`,
    // Find on page
    findPlaceholder: "Find on page…",
    noMatches: "No matches",
    findHints: (p: { next: string; prev: string; close: string }) =>
      `${p.next} next · ${p.prev} previous · ${p.close} close`,
    findScopeNote: "Search covers the main page and same-origin embeds",
    // Password bar
    savePasswordLead: "Save password for",
    savePasswordTail: (p: { host: string }) =>
      ` on ${p.host} to the Keychain?`,
    thisSite: "this site",
    thisPage: "this page",
    save: "Save",
    notNow: "Not now",
    neverForSite: "Never for this site",
    signInAs: (p: { host: string }) => `Sign in to ${p.host} as`,
    noUsername: "(no username)",
    // Certificate interstitial
    certTitle: "This connection is not private",
    certProceed: (p: { host: string }) => `Continue to ${p.host} (unsafe)`,
    certNote: (p: { host: string }) =>
      `Continuing is remembered for ${p.host} only. You can take it back in Settings.`,
    slowPageTitle: "The page has not responded for 10 seconds.",
    slowPageNext: "It may still be loading — you can keep waiting, or reload.",
    // Corner status line over the page
    pageHint: (p: { url: string; keys: string }) =>
      `${p.url} — ${p.keys} for address bar`,
    // The ⌘N new-tab chooser
    newTabMenu: {
      title: "New tab",
      terminal: "Terminal",
      terminalHint: "A shell session",
      files: "Files",
      filesHint: "Explorer with git status and previews",
      browser: "Browser",
      browserHint: "Embedded web page",
      remote: "Join remote…",
      remoteHint: "Watch or control a tab shared from another device",
      settings: "Settings",
      settingsHint: "Preferences",
      profiles: "Profiles",
      profileHintPlain: "Opens a terminal under this profile",
      templates: "Layouts",
      templatesEmpty: "No saved layouts yet.",
      templateHintPlain: "One terminal, wherever it starts",
      templateHintCells: (p: { count: number; cwd: string }) =>
        `${plural(p.count, "terminal")}${p.cwd ? ` · first in ${p.cwd}` : ""}`,
    },
  },
  remote: {
    // Human lines for the host-sent End reasons (wire strings in
    // crates/tabverse-remote). Unmapped reasons fall back to endedGeneric
    // with the raw reason kept as detail.
    endedStopped: "The host stopped sharing this tab.",
    endedKicked: "The host removed this viewer from the session.",
    endedExpired: "This ticket has expired — ask the host for a fresh one.",
    endedGeneric: "The shared session ended.",
    reconnectChip: (p: { attempt: number }) =>
      `Reconnecting (attempt ${p.attempt})…`,
    viewOnlyChip: "View only",
    viewportChip: (p: { cols: number; rows: number; percent: number }) =>
      `Remote viewport ${p.cols}×${p.rows}, shown here at ${p.percent}%`,
    // The standalone Join viewer (apps/join) imports these across the
    // src boundary, the same way it already imports describeError.
    web: {
      loadingClient: "Loading client…",
      connectingRelay: "Connecting through relay…",
      connected: "Connected",
      appShareLive: "App share — the host's workspace is mirrored",
      browserPane: {
        loading: "Loading through the host's network…",
        mirroredChip:
          "Mirrored via the host's network — scripts off, subresources unloaded",
        frameTitle: (p: { url: string }) => `Mirrored page ${p.url}`,
        unmirroredLabel: "Not mirrored — loads independently",
        unmirroredWhy: "The host's proxy could not fetch this page.",
        unmirroredStatus: (p: { status: string }) =>
          `The host's proxy answered ${p.status}.`,
        unmirroredType: "The host fetched a page that is not an HTML document.",
        openOriginal: "Open the original page",
      },
      pasteToBegin: "Paste a ticket to begin",
      fit: "Fit",
      fitPercent: (p: { percent: number }) => `Fit ${p.percent}%`,
    },
  },
  settings: {
    title: "Settings",
    /**
     * The section rail down the side of the page. Its entries are not copy
     * of their own — each one renders the section's own `heading` leaf, so
     * there is nothing here to drift out of step with the page.
     *
     * `group*` are the captions between the entries: eighteen sections read
     * as six families (the grouping lives in settingsSections.ts, which is
     * also what decides when a caption appears).
     */
    nav: {
      label: "Settings sections",
      groupGeneral: "General",
      groupTerminal: "Terminal",
      groupBrowser: "Browser",
      groupNetwork: "Network & data",
      groupAutomation: "Automation",
      groupDanger: "Danger zone",
    },
    search: {
      label: "Search settings",
      noMatches: (p: { query: string }) =>
        `Nothing here matches “${p.query}”. Clear the box to see every setting again.`,
    },
    status: {
      heading: "Status",
      version: "Version",
      runtime: "Runtime",
      runtimeDesktop: "Desktop app",
      runtimeDemo: "Browser demo (no shell)",
      shellIntegration: "Shell integration",
      shellInstalled: "Installed — command blocks active",
      shellMissing: "Not installed for this shell (blocks unavailable)",
      home: "Home",
      sharedTabs: "Shared tabs",
      noneShared: "None",
      sharedEntry: (p: { title: string; viewers: number }) =>
        `${p.title} (${plural(p.viewers, "viewer")})`,
    },
    plugins: {
      heading: "Plugins",
      blurb:
        "Enable, disable or remove the trusted plugins bundled with this copy of Tabverse. " +
        "A plugin with an open tab, active share, resident runtime or enabled dependent stays in place until that blocker is closed.",
      trustBoundary:
        "This catalog does not download plugins or execute untrusted or newly installed native code.",
      runtime: "Runtime service",
      required: "Required local control plane",
      stateRetained: "Saved state retained",
      install: "Install",
      enable: "Enable",
      disable: "Disable",
      uninstall: "Uninstall",
      repair: "Restore last stable state",
      retry: "Retry",
      state: {
        "not-installed": "Not installed",
        installing: "Installing",
        installed: "Installed",
        enabling: "Enabling",
        enabled: "Enabled",
        disabling: "Disabling",
        disabled: "Disabled",
        uninstalling: "Uninstalling",
        failed: "Needs recovery",
      },
    },
    appearance: {
      heading: "Appearance",
      blurb:
        "System follows this device's light or dark appearance; every other " +
        "choice holds one look. The choice takes effect at once and is kept " +
        "on this machine.",
      system: "System",
      // The three short titles the settings registry points at
      // (src-tauri/src/config.rs, str_key). They name one setting each, not
      // the section around them: search results and the "changed" view list
      // settings, and "Appearance" three times over would tell nobody which
      // row they were looking at.
      theme: "Theme",
      sidebarWidth: "Sidebar width",
      sidebarPinned: "Keep the sidebar open",
      terminalFontBlurb:
        "Terminal text is drawn in this font, at this size, with this " +
        "spacing. It applies to every terminal at once — the tabs, the panel " +
        "under a file listing, and a session mirrored from another machine — " +
        "and nothing restarts: the shells keep running and keep their " +
        "scrollback.",
      terminalFontFamily: "Terminal font",
      terminalFontSize: "Terminal text size",
      terminalLineHeight: "Terminal line spacing",
      terminalFontPlaceholder: "The fonts this app ships with",
      terminalFontEmptyNote:
        "Nothing set, so terminals use the fonts this app ships with.",
      terminalFontOkNote: "This machine has it.",
      terminalFontMissingNote: (p: { names: string }) =>
        `Not installed on this machine: ${p.names}. ` +
        `It is saved all the same — install the font and terminals will ` +
        `pick it up.`,
      terminalFontIconNote:
        "The bundled icon font stays behind whatever you name, so prompt " +
        "symbols keep working.",
      terminalFontSizeUnit: "Measured in points.",
      terminalLineHeightUnit:
        "Percent of the font's own line height, so 100 is single-spaced.",
      terminalLigatures: "Programming ligatures",
      terminalLigaturesNote:
        "Draws the arrows and comparison pairs a font joins into one glyph. " +
        "It costs the graphics acceleration: a terminal drawing ligatures is " +
        "drawn by the engine instead, which is slower on long bursts of " +
        "output. Off, every terminal keeps the accelerated renderer.",
      // Said because the three settings above behave the OTHER way — a font
      // change reaches terminals that are already open — and a switch that
      // looked like it had done nothing would be read as broken.
      terminalLigaturesWhen:
        "Unlike the font settings above, this applies to terminals opened " +
        "afterwards: a terminal keeps the renderer it started with, so open " +
        "a new one to see the change.",
      terminalLigaturesScope:
        "It reaches terminal tabs and the panes they are split into. A " +
        "session mirrored from another machine, and the shell under a file " +
        "listing, keep the accelerated renderer and draw no ligatures.",
      terminalLigaturesUnread:
        "Waiting for the configuration file before this can be changed.",
      terminalBackgroundTasks: "Keep terminal tasks running in the background",
      terminalBackgroundTasksNote:
        "Off keeps today’s behavior: closing a terminal tab stops its task, " +
        "and quitting the app stops running tasks. On does not move tasks " +
        "to the background automatically; closing a busy tab or quitting " +
        "while tasks run asks what to do.",
      terminalBackgroundTasksUnread:
        "Waiting for the configuration file before this can be changed.",
      terminalImageMemory: "Inline image memory",
      terminalImageMemoryUnit:
        "Megabytes of decoded image storage, per terminal pane.",
      terminalImageMemoryWhen:
        "Each pane keeps the image storage it was created with, so this " +
        "reaches terminals opened afterwards. Splitting a tab gives every " +
        "pane this much of its own.",
      terminalPasteGuard: "Ask before pasting multiple lines",
      terminalPasteGuardNote:
        "Pasting two or more lines executes and keystrokes straight into " +
        "whatever is running. With this on, such a paste shows a preview " +
        "first; single lines paste as before.",
      terminalPasteGuardWhen:
        "Takes effect on the next paste in every terminal, including ones " +
        "already open.",
      on: "On",
      off: "Off",
    },
    config: {
      errorHeading: "Your configuration file could not be read",
      errorBlurb:
        "Nothing in the file has been changed, and nothing you set through " +
        "this page will be saved until it loads. Settings on screen are the " +
        "built-in ones.",
      openFile: "Show the file",
      writeFailedHeading: "Some changes could not be saved",
      writeFailedBlurb:
        "Your configuration file could not be written, so these settings " +
        "are back on the values they had. Once the file can be saved, " +
        "change them again.",
      writeFailedLine: (p: { setting: string; reason: string }) =>
        `${p.setting} — ${p.reason}`,
      dismissWriteFailures: "Close",
      /**
       * The reason the browser demo gives when its write-failure switch is
       * on (state/config.ts). It stands where the core's own words stand on
       * the desktop, and says which switch produced it so nobody reads the
       * banner as a fault in the page they are walking through.
       */
      demoWriteRefused:
        "This demo is set to refuse writes; its write-failure switch is on.",
      warningsHeading: "Some lines in your configuration file were not used",
      warningLine: (p: { line: number; key: string }) =>
        `Line ${p.line}: ${p.key} is not a setting Tabverse knows.`,
      warningsBlurb:
        "They may be typed wrongly, or belong to a newer version. " +
        "Everything else in the file was read as written, and these lines " +
        "are left exactly as they are.",
      dismissWarnings: "Close",
    },
    changed: {
      onlyChanged: "Show only what I have changed",
      none: "Nothing here differs from its built-in value.",
      blurb:
        "These settings are the ones your configuration file sets to " +
        "something other than the built-in value. Resetting one removes " +
        "its line from the file, so it follows the built-in value again — " +
        "including when a later version of Tabverse improves that value.",
      reset: "Reset",
      /** Names which setting a reset button belongs to, for a screen reader. */
      resetOne: (p: { setting: string }) => `Reset ${p.setting}`,
    },
    defaultApps: {
      heading: "Default apps",
      blurb:
        "Each switch hands a set of things the system opens over to " +
        "Tabverse, and hands them back when you turn it off. Turning one " +
        "on is the only thing that takes a file type away from another " +
        "app — though a type nothing opened before may start opening here " +
        "just because Tabverse is installed. Whoever held each one first " +
        "is remembered, so it can be given back.",
      reading: "Reading what this Mac currently opens…",
      browserTitle: "Default browser",
      browserBlurb:
        "Links clicked anywhere on this Mac open in a browser tab here " +
        "instead of starting another browser.",
      terminalTitle: "Default terminal",
      terminalBlurb:
        "Double-clicking a script or an executable runs it in a terminal " +
        "tab, and ssh:// links connect in one.",
      editorTitle: "Default editor",
      editorBlurb:
        "Double-clicking a file the file tab genuinely serves — code, " +
        "text, data, certificates, databases — opens it here. Things it " +
        "can only display (images, media, Office documents, archives, " +
        "fonts) stay with the apps made for them, reachable via Open With.",
      opensAll: (p: { total: number }) =>
        `Tabverse opens all ${p.total} of these.`,
      opensSome: (p: { held: number; total: number }) =>
        `Tabverse opens ${p.held} of ${p.total}; the rest go elsewhere.`,
      currently: (p: { app: string }) => `Currently ${p.app}.`,
      nothing: "nothing",
      stillElsewhere: (p: { apps: string }) => `Still elsewhere: ${p.apps}`,
      working: "Working…",
      turnOff: "Turn off",
      makeDefault: "Make default",
      registerAndOpen: "Register and open Settings…",
    },
    keyboard: {
      heading: "Keyboard",
      blurb:
        "These are the keys in force: what the app ships with, plus " +
        "anything the keys section of your configuration file changes. An " +
        "empty value there unbinds a command, and it then answers no key " +
        "at all.",
      pageDelay:
        "A web page that is already open keeps the keys it was opened " +
        "with. Reload it, or open a new tab, to give it the new ones.",
      /** Column heading over the per-row buttons. */
      actions: "Change",
      /** Per-row buttons. */
      change: "Change key",
      unbind: "Remove key",
      reset: "Back to the shipped key",
      cancel: "Cancel",
      save: "Use this key",
      /** Shown in the row that is listening for a key. */
      pressNow: "Press the key you want. Escape leaves it as it is.",
      free: (p: { keys: string }) => `${p.keys} is free.`,
      takenBy: (p: { keys: string; action: string }) =>
        `${p.keys} already runs “${p.action}”. ` +
        `One key answers one command, so putting a second one there would ` +
        `leave one of them unreachable. Pick another key, or take the key ` +
        `off that one first.`,
      takenByView: (p: { keys: string; action: string }) =>
        `${p.keys} is “${p.action}”, which a view answers on its own. ` +
        `Both would run: the view's listener and the app-wide one sit side ` +
        `by side, and neither can call the other off.`,
      heldByApp: (p: { keys: string; holder: string }) =>
        `${p.keys} is ${p.holder}, which this app answers outside the shortcut table. ` +
        `Binding it here does not take it away from there.`,
      heldBySystem: (p: { keys: string; holder: string }) =>
        `${p.keys} belongs to the system (${p.holder}), and may never reach this window at all.`,
      /** Why the two above warn instead of refusing. */
      heldNote:
        "Saving it anyway is allowed: no list of the keys other software " +
        "takes can ever be complete, so this is a warning and not a refusal.",
      unknowable:
        "Two kinds of clash cannot be checked from here: a web page can " +
        "claim any key while it is open, and a program running in a " +
        "terminal answers whatever it likes.",
      lookup: "Look up a key",
      lookupListening: "Press any key…",
      lookupHit: (p: { keys: string; action: string }) =>
        `${p.keys} runs “${p.action}”.`,
      lookupHeld: (p: { keys: string; holder: string }) =>
        `${p.keys} is ${p.holder}.`,
      lookupMiss: (p: { keys: string }) => `Nothing here answers ${p.keys}.`,
      /**
       * What holds a key that is not in the shortcut table
       * (`src/reservedKeys.json` points at these by path).
       */
      reserved: {
        quit: "Quit",
        hide: "Hide the window",
        hideOthers: "Hide the other apps",
        minimize: "Minimize",
        fullScreen: "Full screen",
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        selectAll: "Select all",
        switchApps: "Switching apps",
        spotlight: "Spotlight",
        screenshot: "Taking a screenshot",
        screenshotArea: "Taking a screenshot of a selection",
        screenTools: "The screenshot and recording tools",
        forceQuit: "Force quit",
        lockScreen: "Locking the screen",
        switchWindows: "Switching windows",
        securityScreen: "The security screen",
        taskManager: "Task manager",
      },
    },
    remote: {
      heading: "Remote control",
      blurb:
        "Sharing a terminal tab creates a ticket. Anyone holding it can " +
        "watch and type until you stop sharing. Connections are direct " +
        "between the two devices and end-to-end encrypted — when no " +
        "direct path exists, traffic takes a public relay that can never " +
        "read it. No account and no server of yours is involved.",
      standaloneLead: "For someone with nothing installed, build the standalone page with",
      standaloneTail:
        " and send them the single HTML file it produces — it runs the " +
        "same client in their browser.",
    },
    backgroundTasks: {
      heading: "Background terminal tasks",
      blurb:
        "These sessions are owned by the resident helper, not by a tab. Attach to bring one back into this window, or stop it explicitly.",
      empty: "No terminal tasks are running in the background.",
      attach: "Attach",
      terminate: "Stop task",
      cwd: (p: { cwd: string }) => `Working directory: ${p.cwd}`,
      unknownCwd: "Working directory unavailable",
      running: "Running",
      exited: (p: { code: number }) => `Exited with code ${p.code}`,
      residentDefault: "Keep supported tabs running after Tabverse closes",
      residentDefaultNote:
        "Tabs set to use the app default follow this switch. Only tabs that declare continuous runtime stay alive; Files and ordinary Browser page state are restored but do not keep executing.",
      residentDefaultUnread:
        "Waiting for the configuration file before this can be changed.",
    },
    session: {
      heading: "Session",
      blurb:
        "Tabs and groups are restored on start. An ordinary Remote tab is " +
        "not restored because its ticket may have been revoked. A Remote " +
        "tab with a continuous resident runtime is recovered from that " +
        "still-running runtime instead of silently redialing from saved settings.",
      // The button itself is STR.settings.danger.session — this section
      // explains what a session is, the danger zone is where it is erased.
    },
    autoArchive: {
      heading: "Auto-archive",
      blurb:
        "Tabs in the sidebar's Today list are work passing through. One " +
        "that stays untouched for the time below moves to the archive — " +
        "reachable from the Today divider — with its transcript, drafts " +
        "and place kept. Tabs filed into a folder, the tab you are on, a " +
        "terminal with a command running or fresh output, and a file tab " +
        "with unsaved changes never move.",
      after12h: "After 12 hours",
      after24h: "After 24 hours",
      after7d: "After 7 days",
      never: "Never",
      /** Short title of the one setting in this section (registry str_key). */
      after: "Archive an untouched tab after",
    },
    searchEngine: {
      heading: "Search engine",
      blurb: (p: { keys: string }) =>
        `Where a typed query goes when it is not an address — from the address bar (${p.keys}), a new browser tab, and the command bar alike.`,
      custom: "Custom…",
      /** The two short titles the settings registry points at (str_key). */
      engine: "Engine",
      customTemplate: "Custom search address",
      templatePlaceholder: "https://example.com/search?q=%s",
      templateOkNote: "The query replaces %s.",
      templateBadNote:
        "Needs an http(s) address containing %s where the query goes — " +
        "not saved until it does.",
    },
    network: {
      heading: "Name lookups (DNS)",
      blurb:
        "How Tabverse turns a hostname into an address. Through the system " +
        "is what everything else on this computer does. A DNS-over-HTTPS " +
        "provider takes each lookup over an encrypted connection instead — " +
        "which hides it from the network you are on, and shows it to that " +
        "provider.",
      /** Short titles of the settings in this section (registry str_key). */
      dnsMode: "Look names up through",
      dnsCustomUrl: "Custom lookup address",
      system: "The system",
      custom: "Custom…",
      customPlaceholder: "https://example.com/dns-query",
      customEmptyNote:
        "Nothing is filled in yet, so lookups still go through the system.",
      customOkNote: "Lookups are sent here.",
      customBadNote:
        "Needs an https address — or an http one only if the resolver runs " +
        "on this computer. Not saved until it does.",
      coverPageTraffic: "Page traffic through secure DNS too",
      coverNote:
        "A browser tab carries the page itself: its own navigations and " +
        "subresources. With this on, they resolve through the provider " +
        "chosen above. Tabverse’s own fetches — site icons, userscripts and " +
        "the requests those make and completions — already follow " +
        "that provider, whatever this switch says.",
      coverWhen:
        "WebKit shares one page-data store, so page routing is global, not " +
        "per tab. Opening or reopening a browser tab applies the current " +
        "switch to that shared route; loads already in flight finish where " +
        "they started.",
      coverUnread:
        "Waiting for the configuration file before this can be changed.",
      coverGateNote:
        "This Mac is running a macOS older than 14, whose page engine " +
        "cannot be given a proxy. Page traffic stays on the system " +
        "resolver whatever this switch says.",
      coverWindowsNote:
        "On Windows the page engine is WebView2, which the system keeps up " +
        "to date, so there is no version to check: when this is on and a " +
        "provider is chosen, page traffic is covered.",
      proxyDownHeading: "Secure DNS for pages is not running",
      proxyDownBlurb:
        "The local proxy that carries browser tabs’ traffic has stopped. " +
        "The shared page route has fallen back to the system resolver; a " +
        "load that was already in flight may need to be retried.",
      uncoveredHeading: "What this setting does not reach",
      uncoveredWebview:
        "Browser tabs. The page engine issues its own requests, and nothing " +
        "carries them through the provider above, so a page resolves " +
        "through the system.",
      coveredWebview:
        "Browser tabs. A page’s own navigations and subresources resolve " +
        "through the secure DNS provider.",
      coverDownWebview:
        "Browser tabs. The proxy that carries them through the provider is " +
        "not running, so a page is resolving through the system for now.",
      uncoveredRemote:
        "Remote sessions. They reach the other machine over their own " +
        "transport through a relay, which never asks this.",
      uncoveredTerminal:
        "Terminal commands. A shell you start inherits your own settings, " +
        "which is what a login shell is for.",
      uncoveredProvider:
        "The provider’s own address is resolved by the system, because " +
        "something has to look it up before it can be asked anything.",
      restartNote:
        "Site icons and userscripts build their connection once and keep the " +
        "previous setting until Tabverse is restarted. Everything else uses " +
        "the new one straight away.",
    },
    history: {
      heading: "Browsing history",
      blurb: (p: { keys: string }) =>
        `New browser tabs suggest sites you have been to, and ${p.keys} lists every page visited. Both records are kept on this machine only — never sent anywhere, never synced — and this button erases both.`,
      // Erasing them is STR.settings.danger.history, in the danger zone.
    },
    passwords: {
      heading: "Saved passwords",
      showAll: "Show all passwords…",
      importFile: "Import from a file…",
      exportFile: "Export to a file…",
      // The button that forgets every login, its question and its proceed
      // label used to be three leaves here. They are STR.settings.danger's
      // now: the act moved into the danger zone, and a second wording of the
      // same question left behind is how the two come to differ.
      forgotResult: (p: { count: number }) =>
        `Forgot ${plural(p.count, "saved login")}.`,
      csvFilterName: "Comma-separated values",
      exportedResult: (p: { count: number }) =>
        `Wrote ${plural(p.count, "login")}. That file holds them in plain text — move it somewhere safe and delete it once it has been imported.`,
      importedAdded: (p: { count: number }) => `Added ${p.count}.`,
      importedSkipped: (p: { count: number }) =>
        ` Skipped ${p.count} with no site or no password.`,
      importedFailed: (p: { count: number; error: string }) =>
        ` ${p.count} refused by the keychain: ${p.error}`,
    },
    migrate: {
      heading: "Backup & migrate",
      blurb:
        "Export your whole workspace — tabs and groups, history, " +
        "downloads, settings, certificate exceptions, site permissions, " +
        "userscripts and saved passwords — into one file to move to " +
        "another computer. The file is encrypted with a passphrase you " +
        "set; without it the file cannot be opened. Import replaces " +
        "everything on this computer, after copying the current state to " +
        "a timestamped backup folder first. Website login state does not " +
        "travel — you log back in on the other machine, and your saved " +
        "passwords fill them.",
      exportBtn: "Export…",
      importBtn: "Import…",
      filterName: "Tabverse migration",
      exportPassTitle: "Set a passphrase for this export",
      exportPassNote:
        "It encrypts the whole file — every saved password and your " +
        "browsing history are inside. There is no way to open the file " +
        "without it, and no recovery if it is lost.",
      exportedResult: (p: { scopes: number; passwords: number }) =>
        `Exported ${plural(p.scopes, "scope")} and ${plural(p.passwords, "password")}. Keep the file and its passphrase apart and safe — together they are your whole workspace.`,
      importPassTitle: "Enter the passphrase",
      importPassNote: "The passphrase this file was exported with.",
      openLabel: "Open",
      replaceQuestion: (p: {
        scopes: number;
        passwords: number;
        backupPath: string;
      }) =>
        `This replaces everything on this computer with the archive's ${plural(p.scopes, "scope")} and ${plural(p.passwords, "password")}. It is a whole replace, not a merge. Your current state is copied first to ${p.backupPath} so nothing is lost.`,
      replaceLabel: "Replace everything",
      importedResult: (p: {
        scopes: number;
        passwords: number;
        backupPath: string;
      }) =>
        `Imported ${plural(p.scopes, "scope")} and ${plural(p.passwords, "password")}. Your previous state is at ${p.backupPath}. Quit and reopen Tabverse for the import to take effect — and log back in to your sites, since login state does not travel.`,
    },
    danger: {
      heading: "Danger zone",
      blurb:
        "Everything here erases something for good. Each one asks first, " +
        "and none of them can be taken back afterwards.",
      /**
       * The one question shape. `erases` says what goes, and it leads —
       * a question that opens with what will be lost is answerable before
       * the rest of it has been read, and the rest is the same two sentences
       * every time, so the four read as four answers to one question rather
       * than as four separately-worded warnings.
       */
      question: (p: { erases: string }) =>
        `${p.erases}. This cannot be undone. ` +
        `Want a copy first? Close this and export one from Backup & migrate. ` +
        `Continue?`,
      /** What each action erases, filling the slot above. */
      sessionErases:
        "Every saved tab and group goes, along with the work each tab was " +
        "holding — open files, drafts, terminal history",
      historyErases:
        "Every page you have visited on this machine goes, and with it the " +
        "suggestions new browser tabs make from your visits",
      passwordsErases: "Every login saved in this Mac's keychain goes",
      factoryErases:
        "Every saved tab and group goes, with your browsing history and " +
        "downloads, the keys you have changed and the theme you chose",
      /** The button on the page, and the one in the confirmation. */
      session: "Forget saved session",
      sessionConfirm: "Forget the session",
      history: "Clear browsing history",
      historyConfirm: "Clear the history",
      passwords: "Forget all passwords…",
      passwordsConfirm: "Forget them all",
      factory: "Restore factory settings…",
      factoryConfirm: "Restore factory settings",
      /**
       * What the factory reset leaves alone, said on the page rather than
       * discovered afterwards: the keychain is not state this app maintains,
       * and the rest of the configuration file is the user's own writing.
       */
      factoryKeeps:
        "Your saved passwords and the rest of your configuration file are " +
        "not touched — forget passwords with the button above, and edit the " +
        "file for the rest.",
      factoryDone:
        "Restored. Quit and reopen Tabverse for every part of it to take " +
        "effect.",
    },
    sites: {
      heading: "Sites",
      blurb:
        "Everything this app remembers about a site, in one place: camera " +
        "and microphone permissions, certificate exceptions, per-site zoom, " +
        "and the domains user scripts are allowed to reach. Every entry can " +
        "be taken back where it stands — the site simply asks again.",
      permissionsHeading: "Camera and microphone permissions",
      permissionsNone:
        "No camera or microphone answer is remembered for any site yet.",
      allowed: "Allowed",
      refused: "Refused",
      certsHeading: "Certificate exceptions",
      certsBlurb:
        "Sites you chose to open despite a certificate this Mac does not " +
        "trust. Each one was a deliberate click; removing it puts the " +
        "warning back.",
      certsNone: "None — every site so far presented a trusted certificate.",
      zoomHeading: "Zoom per site",
      zoomNone: "No site-specific zoom is remembered yet.",
      scriptsHeading: "User script domains",
      scriptsNone: "No user script has been granted a domain yet.",
      scriptsSecondLine: "Granted to",
      remove: "Remove",
      scriptRevokeHint: (p: { script: string; host: string }) =>
        `Stop ${p.script} reaching ${p.host}`,
      clearAll: "Clear all site memory…",
      clearConfirm: "Clear site memory",
      clearQuestion:
        "Forget everything listed here — permissions, certificate " +
        "exceptions, zoom levels, and user script domains? Each site will " +
        "ask again next time.",
    },
    userscripts: {
      heading: "User scripts",
      blurb:
        "Userscripts are small programs you install that run on the pages " +
        "they match — Greasemonkey/Tampermonkey style. They run in the " +
        "page, so install only scripts you trust; cross-site network " +
        "requests are allowed per script and per domain, below. Bodies " +
        "stay on this machine, nothing is uploaded, and updates are never " +
        "automatic: a script changes only when you press its Check " +
        "button, review the diff, and accept it.",
      demoNote:
        "Userscripts run against embedded web pages, which only exist in " +
        "the desktop app.",
      urlPlaceholder: "https://example.com/script.user.js",
      working: "Working…",
      installFromUrl: "Install from URL",
      installFromFile: "Install from file…",
      fileFilterName: "Userscript",
      reading: "Reading installed scripts…",
      noneInstalled:
        "None installed. Paste a script’s URL above, or pick a local file.",
      removeQuestion: (p: { name: string }) =>
        `Remove “${p.name}”? Its stored values and allowed domains go with it.`,
      remove: "Remove",
      matchesNothing: "Matches nothing",
      version: (p: { version: string }) => `v${p.version}`,
      matchLine: (p: { summary: string; runAt: string }) =>
        `${p.summary} · at ${p.runAt}`,
      allowedDomains: "Allowed domains:",
      revokeHint: (p: { host: string }) => `Revoke ${p.host}`,
      on: "On",
      off: "Off",
      checkForUpdate: "Check for update",
      checkingUpdate: "Checking…",
      upToDate: (p: { name: string }) =>
        `“${p.name}” is already up to date.`,
      // The reason a row's Check button is disabled: no URL was involved in
      // that install, so there is nothing honest to check against.
      checkNoSource:
        "Installed from a file or pasted text — this script has no update source",
      update: {
        title: (p: { name: string }) => `Update “${p.name}”?`,
        sourceNote: (p: { url: string }) =>
          `Checked against ${p.url} — the URL it was installed from, pinned.`,
        versionSpan: (p: { from: string; to: string }) => `${p.from} to ${p.to}`,
        blurb:
          "Review every change below — nothing is written until you choose " +
          "to update. A header line can change where a script runs or what " +
          "it may ask for; those lines are part of the diff, not fine " +
          "print.",
        grantsCleared:
          "Updating clears every allowed domain: the new version asks " +
          "again the first time it reaches for one.",
        removedLegend: "Removed",
        addedLegend: "Added",
        moreLines: (p: { count: number }) =>
          `… ${p.count.toLocaleString()} more lines not shown`,
        updateTo: (p: { version: string }) => `Update to v${p.version}`,
        applying: "Updating…",
        applied: (p: { name: string; version: string }) =>
          `Updated “${p.name}” to v${p.version}. Its allowed domains were cleared — they will ask again.`,
      },
    },
    completions: {
      heading: "Terminal completions",
      blurb:
        "While you type a command the terminal can offer the flags the " +
        "command is known to take, from a spec it keeps on this machine. " +
        "The list is a menu of the common ones, not an inventory — an " +
        "absent flag is not advice against it.",
      /** The registry title for `terminal.completions_url`. */
      url: "Update source",
      urlNote:
        "The address “Update now” fetches the spec from. Only http(s), " +
        "fetched by the app itself.",
      currentVersion: (p: { version: string }) =>
        `Loaded: ${p.version}`,
      currentNone: "No spec loaded — nothing is offered.",
      snapshotVersion: (p: { version: string }) =>
        `Shipped snapshot: ${p.version}`,
      fromUpdate: "(from an update)",
      fromSnapshot: "(the shipped snapshot)",
      updateNow: "Update now",
      updating: "Updating…",
      updated: (p: { version: string }) =>
        `Updated to ${p.version}.`,
      demoNote:
        "The browser demo loads the shipped snapshot and cannot fetch " +
        "updates — the update channel is a desktop-app feature.",
    },
    profiles: {
      heading: "Terminal profiles",
      blurb:
        "A profile is a name for a way of opening a terminal: which shell, " +
        "in which directory, with which extra environment, wearing which " +
        "badge, in which font, with or without programming ligatures, running " +
        "which command first. Open one from the new-tab picker, or type its " +
        "name after “new:” in the command bar. They live in your configuration " +
        "file and stay on this machine.",
      none: "No profiles yet.",
      add: "Add a profile",
      edit: "Edit",
      remove: "Remove",
      save: "Save",
      removeQuestion: (p: { name: string }) =>
        `Remove the profile “${p.name}”? ` +
        `Terminals already open under it keep running.`,
      // The one-line summary under a profile's name in the list. Every part
      // is what that profile actually says; a profile that says nothing but
      // its name gets `summaryPlain` instead of an invented description.
      summaryPlain: "Opens a plain terminal under this name.",
      summaryLigaturesOn: "Ligatures on",
      summaryLigaturesOff: "Ligatures off",
      name: "Name",
      shell: "Shell",
      shellPlaceholder: "The shell a plain terminal gets",
      cwd: "Starting directory",
      cwdPlaceholder: "Your home directory",
      env: "Environment",
      envHint:
        "One name=value per line, added on top of what the shell inherits.",
      envRefusal: (p: { line: number }) =>
        `Line ${p.line} of the environment is not name=value.`,
      badge: "Badge colour",
      badgeHint:
        "The colour a pane and its sidebar row wear under this profile.",
      font: "Font",
      fontHint:
        "Overrides the terminal font family for terminals opened under this " +
        "profile. Size and spacing stay as they are set above.",
      ligatures: "Programming ligatures",
      ligaturesFollow: "Follow the global setting",
      ligaturesOn: "On for this profile",
      ligaturesOff: "Off for this profile",
      ligaturesHint:
        "On gives terminals opened under this profile programming ligatures " +
        "and the non-accelerated renderer. Off keeps graphics acceleration. " +
        "Follow changes with the global switch above.",
      runOnStart: "Start command",
      runOnStartHint:
        "Typed into the shell as soon as it exists — every time a terminal " +
        "opens under this profile, not once.",
      demoNote:
        "Profiles are saved in the browser here; on the desktop they are " +
        "written to your configuration file.",
    },
    // Rewritten from the broken original ("… readable by this app only.
    // The Nothing about them…") — keep the replacement explicit so the old
    // sentence cannot come back.
    savedPasswordsIntro:
      "Logins live in the macOS Keychain, readable by this app only — " +
      "nothing about them, not even how many there are, is shown until the " +
      "authorization below opens the list. Import reads the comma-separated " +
      "file every other browser exports, and export writes that same shape, " +
      "so these logins can always be taken elsewhere.",
    exportNotAuthorized: "Export cancelled — it was not authorized.",
    passwordsNotAuthorized: "Not authorized — the password list stays closed.",
  },
  share: {
    dialogTitle: (p: { title: string }) => `Remote control — ${p.title}`,
    introBlurb:
      "Share this tab so another device can watch and type into it from " +
      "anywhere. Traffic is end-to-end encrypted — the servers that relay " +
      "it can never read it. No account needed.",
    starting: "Starting…",
    startSharing: "Start sharing",
    accessLabel: "New viewers join with",
    levelName: {
      view: "View",
      steer: "Steer",
      approve: "Approve",
    },
    levelHint: {
      view: "Watch only",
      steer: "Watch and send input",
      approve: "Steer, plus approve privileged actions",
    },
    ttlLabel: "Link admits joiners for",
    ttlHours: (p: { h: number }) => plural(p.h, "hour"),
    ttlNever: "No expiry",
    joinLinkLabel: "Join link",
    joinLinkHint:
      "Opens in any browser — for phones and devices without Tabverse.",
    copyLink: "Copy link",
    rawTicketLabel: "Ticket",
    rawTicketHint: "For pasting into another Tabverse (Join a remote tab).",
    /** The running share, summarized: default level for new joiners plus the
     *  join window. `window` is windowHours/windowNever below. */
    activeSummary: (p: { level: string; window: string }) =>
      `New viewers join with ${p.level} access · ${p.window}.`,
    windowHours: (p: { h: number }) =>
      `the link admits joiners for ${plural(p.h, "hour")}`,
    windowNever: "Link stays open until sharing stops",
    connectedStayNote:
      "Anyone already connected stays until you stop sharing or remove them.",
    viewerAccessLabel: (p: { name: string }) => `Access for ${p.name}`,
    noViewersYet: "No one is watching yet",
    viewerName: (p: { id: number }) => `Viewer #${p.id}`,
    removeViewer: "Remove",
    copied: "Copied ✓",
    copyTicket: "Copy ticket",
    stopSharing: "Stop sharing",
    appPanelTitle: "Share the whole app",
    appIntroBlurb:
      "Let another device watch and steer this entire app — every tab, " +
      "the sidebar, the lot — from anywhere. Traffic is end-to-end " +
      "encrypted; no account needed.",
    appRosterLabel: (p: { n: number }) =>
      `Watching now — ${plural(p.n, "viewer")}`,
    // Join dialog
    joinTitle: "Join a remote tab",
    joinBlurb:
      "Paste a ticket from another Tabverse (“Start sharing” on any " +
      "terminal tab). The connection is peer-to-peer and end-to-end " +
      "encrypted.",
    joinDemoWarn:
      "This browser demo has no networking — joining works in the desktop " +
      "app (or the standalone remote page).",
    ticketPlaceholder: "tabv…",
    join: "Join",
    joining: "Joining…",
  },
  panels: {
    // Relative-time chips ("3m ago"): data-like, shared by the archive,
    // history, downloads and folder-preview rows.
    time: {
      justNow: "just now",
      minutesAgo: (p: { m: number }) => `${p.m}m ago`,
      hoursAgo: (p: { h: number }) => `${p.h}h ago`,
      daysAgo: (p: { d: number }) => `${p.d}d ago`,
    },
    clearAll: "Clear all",
    folderPreview: {
      opening: "Opening…",
    },
    archive: {
      searchPlaceholder: "Search title, address or folder",
      noMatch: "Nothing on the shelf matches that search.",
      evictedLine: (p: { count: number }) =>
        `The oldest ${plural(p.count, "entry")} already had to make way — ` +
        "the shelf holds 500.",
      clearAllQuestion: (p: { count: number }) =>
        `Clear all ${plural(p.count, "archived tab")}? There is no undo.`,
      emptyCount: "Nothing archived",
      count: (p: { count: number }) => plural(p.count, "archived tab"),
      emptyBlurb:
        "Nothing here yet. Tabs left untouched in the Today list are " +
        "moved here instead of piling up — with their transcript, drafts " +
        "and place kept — while tabs you filed into a folder stay put.",
      deleteEntryHint: "Delete this entry",
    },
    history: {
      searchPlaceholder: "Search title or address",
      emptyCount: "No history",
      count: (p: { count: number }) => plural(p.count, "visit"),
      clearAllQuestion: (p: { count: number }) =>
        `Clear all browsing history (${plural(p.count, "entry", "entries")} ` +
        "and the site suggestions)? There is no undo.",
      emptyBlurb:
        "Nothing here yet. Pages you visit in browser tabs are listed " +
        "here — on this machine only, never uploaded or synced.",
      noMatch: "Nothing matches that search.",
      dayToday: "Today",
      dayYesterday: "Yesterday",
      dayEarlier: "Earlier",
    },
    downloads: {
      emptyCount: "No downloads",
      count: (p: { count: number }) => plural(p.count, "download"),
      clearAllQuestion: (p: { count: number }) =>
        `Clear all ${plural(p.count, "download record")}? The files ` +
        "themselves stay where they are.",
      emptyBlurb:
        "Nothing downloaded yet. Files pages hand over land in your " +
        "Downloads folder and are listed here — records only, on this " +
        "machine; deleting a row never touches the file.",
      stateDownloading: "Downloading…",
      stateDone: "Done",
      stateFailed: "Failed",
      revealHint: "Reveal in Finder",
      reveal: "Reveal",
      openInFilesHint: "Show in a files tab",
      deleteRecordHint: "Delete this record (keeps the file)",
    },
    passwords: {
      filterPlaceholder: "Filter by site or username",
      countSaved: (p: { count: number }) => `${p.count} saved`,
      countOf: (p: { shown: number; total: number }) =>
        `${p.shown} of ${p.total}`,
      copiedNote: (p: { host: string }) =>
        `Copied the password for ${p.host}.`,
      forgetQuestion: (p: { host: string }) =>
        `Forget the saved login for ${p.host}?`,
      forgetLabel: "Forget it",
      reading: "Reading the login store…",
      emptyBlurb: "Nothing saved yet.",
      noMatch: (p: { query: string }) => `Nothing matches “${p.query}”.`,
      show: "Show",
      showHint: "Show this password",
      hide: "Hide",
      hideHint: "Hide it again",
      copy: "Copy",
      copyHint: "Copy this password",
      forgetHint: "Forget this login",
    },
  },
  dialogs: {
    sessionRecovery: {
      problem: (p: {
        reason:
          | "read-failed"
          | "invalid-json"
          | "migration-failed"
          | "unsupported-version"
          | "invalid-shape"
          | "empty-tabs";
      }) => {
        const reason = {
          "read-failed": "Tabverse could not read the saved session file",
          "invalid-json": "The saved session file is not valid JSON",
          "migration-failed":
            "Tabverse could not create a durable backup and migrate the saved session",
          "unsupported-version": "The saved session file uses an unsupported version",
          "invalid-shape": "The saved session file has an invalid structure",
          "empty-tabs": "The saved session file has no tabs",
        }[p.reason];
        return `${reason}. The file has not been changed. Starting a new session will replace it, so do that only if you are sure it is not needed for recovery.`;
      },
      initialize: "Start new session and replace saved session",
    },
    saveTemplate: {
      title: "Save this layout",
      blurb:
        "A layout remembers how this tab's terminals are arranged, where " +
        "each one starts and which profile it runs under. Open it from the " +
        "new-tab picker, or type its name after “new:”.",
      name: "Name",
      paneSummary: (p: { n: number; cwd: string; profile: string }) =>
        `Pane ${p.n} — in ${p.cwd}, under ${p.profile}`,
      panePlainCwd: "Your home directory",
      panePlainProfile: "No profile",
      commandLabel: "Start command",
      commandPlaceholder: "None — this pane starts empty",
      commandHint:
        "Left empty on purpose: the command that started a pane cannot be " +
        "read back from a running shell, and a guess would run every time " +
        "the layout opens. Fill one in only where a pane should always " +
        "start with it.",
      replaceNote: (p: { name: string }) =>
        `A layout named “${p.name}” already exists; saving replaces it.`,
      existing: "Saved layouts",
      remove: "Remove",
      removeQuestion: (p: { name: string }) =>
        `Remove the layout “${p.name}”? Terminals already open keep running.`,
      save: "Save",
    },
    deleteFolderQuestion: (p: { name: string }) =>
      `Delete the folder “${p.name}”?`,
    deleteFolderLift: "Move contents up",
    deleteFolderClose: "Close tabs too",
    // HTTP Basic/Digest login
    auth: {
      signInLead: "Sign in to",
      savedPasswordRejected: "The saved password was not accepted.",
      username: "Username",
      password: "Password",
      rememberInKeychain: "Remember in Keychain",
      signIn: "Sign in",
    },
    // Migration-archive passphrase
    passphrase: {
      placeholder: "Passphrase",
      repeatPlaceholder: "Repeat the passphrase",
      mismatch: "The two entries do not match.",
      shortWarning:
        "That is short. A longer passphrase protects the file better — " +
        "but it is your call.",
    },
    // Page-owned dialogs (alert / confirm / prompt / permissions / unload)
    page: {
      thisPage: "This page",
      leaveQuestion: (p: { title: string }) => `Leave ${p.title}?`,
      unsavedWarning:
        "This page says you have unsaved changes. Closing the tab " +
        "discards them.",
      stay: "Stay",
      closeTab: "Close tab",
      wantsNotifications: " wants to send you notifications",
      wantsDevice: (p: { device: string }) => ` wants to use your ${p.device}`,
      says: " says",
      rememberChoice: (p: { site: string }) =>
        `Remember this choice for ${p.site}`,
      dontAllow: "Don't allow",
      allow: "Allow",
    },
    // Userscript cross-site request consent
    userscript: {
      scriptLead: "The script",
      wantsToReach: " wants to reach ",
      fallbackName: "a userscript",
      blurb:
        "Userscripts can only make cross-site requests to domains you " +
        "allow. Allowing is remembered per script and per domain, and can " +
        "be taken back in Settings.",
      deny: "Deny",
      allowOnce: "Allow once",
      allowAlways: "Always allow for this script",
    },
  },
} as const;

export const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`;
