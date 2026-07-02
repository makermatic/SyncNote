/*
 * SyncNote.js  —  Frame.io / SyncSketch-style review notes for Toon Boom Harmony
 * -----------------------------------------------------------------------------
 * Attach text review notes to drawing substitutions inside a scene.
 *
 * What it does:
 *   - On launch, finds (or creates) a "Notes" drawing layer and connects it
 *     to the scene's top Composite so it renders over everything.
 *   - "Add Note" creates a drawing substitution at the playhead; each
 *     substitution group has its own text field for adding dated notes.
 *   - Notes are stored INSIDE the scene (scene metadata), keyed by element ID +
 *     drawing name, so renaming the layer/scene never orphans them.
 *   - Clicking a note's green "Frame ####" link (or the group's Go-to button)
 *     jumps the playhead there, so you see the note and the artwork together.
 *
 * Compatibility: Harmony 22 and 24/25 Premium (Qt Script / ECMAScript).
 *
 * Install: copy to your user scripts folder. When binding a toolbar button,
 *   there is exactly ONE function to pick: SyncNote. All helpers are nested
 *   inside it so they don't clutter the function picker.
 *
 * See syncnote_kb.md for design rationale, API reference, and Qt gotchas.
 */

// Strong references to script-created QObjects (event filters, timers).
// Their JS wrappers hold the script-side method overrides; if the wrapper
// is garbage-collected, the override silently reverts to a no-op — which
// showed up in testing as card clicks randomly dying. Module scope keeps
// them alive for the dialog's lifetime; reset on each launch.
var g_snKeepAlive = [];      // per-refresh objects (card filters, scroll timer)
var g_snKeepAlivePanel = []; // panel-lifetime objects (SceneChangeNotifier,
                             // stale-check timer) — must survive refreshes

function SyncNote() {
  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  var SN_VERSION    = "0.10.1";          // shown in title + status bar so we always know which build runs
  var META_KEY      = "SyncNote";        // scene-metadata key holding our JSON model
  var META_TYPE     = "string";
  var MODEL_VERSION = 1;
  var LAYER_NAME    = "Notes";           // default name for the review layer
  var DLG_NAME      = "SyncNoteDialog";  // objectName used to find/replace open panels
  var LINK_STYLE    = "color:#4CAF50; text-decoration:none;"; // green, SyncSketch-ish

  // ---------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------
  try {
    main();
  } catch (err) {
    MessageBox.information("SyncNote error: " + err);
  }
  return; // everything below is hoisted helper functions

  function main() {
    closeExistingDialog();     // one panel at a time; reopening = refresh
    g_snKeepAlive = [];        // drop refs belonging to the previous panel
    g_snKeepAlivePanel = [];

    var model = loadModel();
    var layer = ensureNotesLayer(model);
    if (!layer) {
      MessageBox.information("SyncNote could not create or find a Notes layer.");
      return;
    }
    var connectStatus = connectNotesNode(layer.node); // wire + verify by RENDER ORDER

    model.syncNoteElementId = layer.elementId;
    saveModel(model);

    // Per the brief: running the script creates a drawing substitution
    // wherever the timeline playhead currently is.
    ensureSubstitutionAtFrame(layer, frame.current());

    revealLayer(layer.node); // select it so it's obvious in Timeline/Node View

    buildDialog(model, layer, connectStatus);
  }

  // =======================================================================
  // DATA LAYER  (scene metadata <-> JSON model)
  //
  // Schema:
  // { version: 1,
  //   syncNoteElementId: <int>,
  //   notesByDrawing: { "<elementId>": { "<drawingName>": [
  //       { id: "n_<ts>", text: "...", date: "<ISO8601>" } ] } } }
  // =======================================================================
  function defaultModel() {
    return { version: MODEL_VERSION, syncNoteElementId: -1, notesByDrawing: {} };
  }

  function loadModel() {
    try {
      var meta = scene.metadata(META_KEY, META_TYPE);
      if (meta && meta.value) {
        var m = JSON.parse(meta.value);
        if (m && m.notesByDrawing) {
          if (m.syncNoteElementId === undefined) m.syncNoteElementId = -1;
          return m;
        }
      }
    } catch (e) { /* fall through to default */ }
    return defaultModel();
  }

  function saveModel(model) {
    scene.setMetadata({
      name:    META_KEY,
      type:    META_TYPE,
      creator: "SyncNote",
      version: String(MODEL_VERSION),
      value:   JSON.stringify(model)
    });
  }

  function notesFor(model, elementId, drawingName) {
    var byEl = model.notesByDrawing[String(elementId)];
    if (!byEl) return [];
    return byEl[drawingName] || [];
  }

  function addNote(model, elementId, drawingName, text) {
    var eid = String(elementId);
    if (!model.notesByDrawing[eid]) model.notesByDrawing[eid] = {};
    if (!model.notesByDrawing[eid][drawingName]) model.notesByDrawing[eid][drawingName] = [];
    model.notesByDrawing[eid][drawingName].push({
      id:   "n_" + (new Date()).getTime(),
      text: text,
      ts:   (new Date()).getTime(), // numeric — Qt Script's Date can't parse ISO strings
      date: (new Date()).toISOString()
    });
  }

  function deleteNote(model, elementId, drawingName, noteId) {
    var arr = notesFor(model, elementId, drawingName);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === noteId) { arr.splice(i, 1); return true; }
    }
    return false;
  }

  // =======================================================================
  // LAYER  (find or create the Notes element / column / READ node)
  // =======================================================================
  function ensureNotesLayer(model) {
    var found = findNotesLayer(model);
    if (found) return found;

    // Recovery: the READ node may have been deleted while the element +
    // column (and all their notes) survive in the scene. Rebuild just the
    // node instead of orphaning the old notes with a brand-new element.
    if (model && model.syncNoteElementId >= 0) {
      var col = findColumnByElementId(model.syncNoteElementId);
      if (col) {
        var rebuilt = createReadNodeFor(col, model.syncNoteElementId);
        if (rebuilt) return rebuilt;
      }
    }
    return createNotesLayer();
  }

  // Scan all columns for a DRAWING column bound to the given element ID.
  function findColumnByElementId(eid) {
    try {
      var n = column.numberOf();
      for (var i = 0; i < n; i++) {
        var name = column.getName(i);
        if (column.type(name) === "DRAWING" &&
            column.getElementIdOfDrawing(name) === eid) return name;
      }
    } catch (e) { /* fall through */ }
    return "";
  }

  // Create just a READ node and link it to an existing column.
  function createReadNodeFor(colName, elementId) {
    scene.beginUndoRedoAccum("SyncNote: rebuild Notes node");
    try {
      var readPath = node.add(node.root(), uniqueNodeName(LAYER_NAME), "READ", 0, 0, 0);
      if (!readPath || node.type(readPath) !== "READ") throw "node.add failed";
      node.linkAttr(readPath, "DRAWING.ELEMENT", colName);
      scene.endUndoRedoAccum();
      return { node: readPath, column: colName, elementId: elementId };
    } catch (e) {
      scene.endUndoRedoAccum();
      return null;
    }
  }

  // node.add fails (returns "") if a sibling by that name exists; probe.
  function uniqueNodeName(base) {
    var name = base;
    for (var i = 1; i < 1000 && node.type(node.root() + "/" + name) !== ""; i++) {
      name = base + "_" + i;
    }
    return name;
  }

  // Priority: stored element ID (rename-proof), then a READ named "Notes".
  function findNotesLayer(model) {
    var reads = node.getNodes(["READ"]);
    var wantId = (model && model.syncNoteElementId >= 0) ? model.syncNoteElementId : -1;

    var byName = null;
    for (var i = 0; i < reads.length; i++) {
      var n = reads[i];
      var col = node.linkedColumn(n, "DRAWING.ELEMENT");
      if (!col) continue;
      var eid = column.getElementIdOfDrawing(col);
      if (wantId >= 0 && eid === wantId) {
        return { node: n, column: col, elementId: eid };   // best: exact element match
      }
      if (!byName && shortName(n).toLowerCase() === LAYER_NAME.toLowerCase()) {
        byName = { node: n, column: col, elementId: eid }; // fallback candidate
      }
    }
    return byName; // may be null
  }

  function createNotesLayer() {
    scene.beginUndoRedoAccum("SyncNote: create Notes layer");
    try {
      // 1) Physical element (folder of drawings).
      var elementId = element.add(LAYER_NAME, "COLOR", 12, "SCAN", "TVG");
      if (elementId < 0) throw "element.add failed";

      // 2) Drawing (exposure) column with a unique name.
      var colName = uniqueColumnName(LAYER_NAME);
      if (!column.add(colName, "DRAWING")) throw "column.add failed";

      // 3) Bind column -> element by ID.
      column.setElementIdOfDrawing(colName, elementId);

      // 4) Visible READ node under Top (unique name; verify it really exists).
      var readPath = node.add(node.root(), uniqueNodeName(LAYER_NAME), "READ", 0, 0, 0);
      if (!readPath || node.type(readPath) !== "READ") throw "node.add failed";

      // 5) Link the node's exposure attribute to our column.
      node.linkAttr(readPath, "DRAWING.ELEMENT", colName);

      scene.endUndoRedoAccum();
      return { node: readPath, column: colName, elementId: elementId };
    } catch (e) {
      scene.endUndoRedoAccum();
      MessageBox.information("SyncNote: failed to create Notes layer (" + e + ")");
      return null;
    }
  }

  // Connect the READ node to the scene's top-level Composite so it renders.
  // Port 0 with mayAddInputPort=true inserts at the LEFTMOST input, which the
  // Composite renders on top — exactly where review notes belong.
  // ---- Connection, redone (v0.9.0) ----------------------------------------
  //
  // Every earlier attempt verified success by PORT INDEX and trusted the docs
  // ("leftmost port renders in front") — and kept disagreeing with what the
  // user saw in the layer stack. This version verifies against the actual
  // RENDER ORDER via compositionOrder.buildDefaultCompositionOrder(), which
  // is literally "the Timeline view's composition order" (frontmost first).
  // It tries a reorder strategy, MEASURES, tries the opposite strategy if
  // needed, and never claims success the measurement doesn't back.
  function connectNotesNode(readPath) {
    var comp = findTopComposite();
    if (!comp) return "no Composite node in scene";

    // 1) Make sure it's connected at all.
    var linked = false;
    try { linked = node.numberOfOutputLinks(readPath, 0) > 0; } catch (e) {}
    if (!linked) {
      try { node.link(readPath, 0, comp, node.numberOfInputPorts(comp), false, true); }
      catch (e) { try { node.link(readPath, 0, comp, 0, false, true); } catch (e2) {} }
      try {
        node.setCoord(readPath, node.coordX(comp) - 60, node.coordY(comp) - 80);
      } catch (e) { /* cosmetic only */ }
      try { linked = node.numberOfOutputLinks(readPath, 0) > 0; } catch (e) {}
      if (!linked) return "NOT connected — plug the Notes node into your Composite";
    }

    // 2) Measure the truth.
    var rank = renderRank(readPath);
    trace("initial render rank: " + rank + " (0 = frontmost layer)");
    if (rank === 0) return "frontmost layer ✓";
    if (rank === -2) return "connected — render order unreadable (see Message Log)";

    // 3) Not frontmost: try both port orders, measuring after each. Which
    // end of the port row is "front" has been ambiguous all along — so let
    // the measurement decide instead of assuming.
    // Measured in live testing (v0.9.0 logs): the LAST-connected port is the
    // frontmost layer — the opposite of the documented "leftmost renders in
    // front". Try the proven winner first; keep the other as a safety net
    // for scenes/versions where the semantics differ.
    var strategies = [
      { notesFirst: false, label: "Notes on last port" },
      { notesFirst: true,  label: "Notes on first port" }
    ];
    for (var s = 0; s < strategies.length; s++) {
      reorderComposite(readPath, comp, strategies[s].notesFirst);
      rank = renderRank(readPath);
      trace("after reorder (" + strategies[s].label + "): rank " + rank);
      if (rank === 0) return "frontmost layer ✓ (" + strategies[s].label + ")";
    }

    // 4) Neither order made it frontmost — the reordered composite is
    // probably not the one that decides stacking in this scene. Dump full
    // diagnostics and say so; do not pretend.
    logCompositionOrder();
    logPortMap();
    return "renders BEHIND " + rank + " layer(s) — diagnostics in Message Log";
  }

  // Notes' place in the real render stack: 0 = frontmost drawing layer,
  // N = that many drawing layers render in front of it, -2 = unmeasurable.
  // Only READ nodes are counted as "layers" — effects/pegs/composites in the
  // stack don't compete with Notes for visibility.
  function renderRank(readPath) {
    try {
      var order = compositionOrder.buildDefaultCompositionOrder();
      if (!order || order.length === undefined) return -2;
      var ahead = 0;
      for (var i = 0; i < order.length; i++) {
        var n = "";
        try { n = String(order[i].node); } catch (e0) { continue; }
        if (n === readPath) return ahead;
        try { if (node.type(n) === "READ") ahead++; } catch (e1) {}
      }
      return -2; // Notes absent from the composition — not rendering at all
    } catch (e) {
      return -2; // API not available in this build
    }
  }

  // Rebuild the composite's input connections with Notes either first or
  // last (ports fill in connection order). Snapshot preserves each source's
  // own output port; whole rewire is one undo step.
  function reorderComposite(readPath, comp, notesFirst) {
    try {
      var sources = [];
      var ports = node.numberOfInputPorts(comp);
      for (var i = 0; i < ports; i++) {
        var srcPath = "";
        var srcPort = 0;
        try {
          var info = node.srcNodeInfo(comp, i);
          if (info) { srcPath = String(info.node); srcPort = Number(info.port) || 0; }
        } catch (e0) { /* older API */ }
        if (!srcPath) { try { srcPath = node.srcNode(comp, i); } catch (e1) {} }
        if (srcPath && srcPath !== "") sources.push({ node: srcPath, port: srcPort });
      }

      var mine = -1;
      for (var s = 0; s < sources.length; s++) {
        if (sources[s].node === readPath) { mine = s; break; }
      }
      if (mine < 0) return;

      var order = [];
      for (var k = 0; k < sources.length; k++) {
        if (k !== mine) order.push(sources[k]);
      }
      if (notesFirst) order.unshift(sources[mine]);
      else order.push(sources[mine]);

      scene.beginUndoRedoAccum("SyncNote: reorder composite");
      try {
        for (var p = ports - 1; p >= 0; p--) {
          try { node.unlink(comp, p); } catch (e) { /* empty port */ }
        }
        for (var j = 0; j < order.length; j++) {
          try {
            node.link(order[j].node, order[j].port, comp,
                      node.numberOfInputPorts(comp), false, true);
          } catch (e) {
            try { node.link(order[j].node, order[j].port, comp, j); } catch (e2) {}
          }
        }
        scene.endUndoRedoAccum();
      } catch (e) {
        scene.endUndoRedoAccum();
      }
    } catch (e) { /* leave the scene as-is */ }
  }

  function trace(msg) {
    try { MessageLog.trace("SyncNote " + SN_VERSION + ": " + msg); } catch (e) {}
  }

  // Full composition order dump (frontmost first) for failure diagnostics.
  function logCompositionOrder() {
    try {
      var order = compositionOrder.buildDefaultCompositionOrder();
      var lines = ["composition order (frontmost first):"];
      for (var i = 0; i < order.length; i++) {
        var n = "?";
        try { n = String(order[i].node); } catch (e0) {}
        var t = "";
        try { t = node.type(n); } catch (e1) {}
        lines.push("   " + i + ": " + n + (t ? "  [" + t + "]" : ""));
      }
      trace(lines.join("\n"));
    } catch (e) {
      trace("compositionOrder API unavailable in this build");
    }
  }


  // Diagnostic for the status bar: which composite input port Notes is on.
  // Port 0 should be the LEFTMOST (front). If the readout says port 0 but the
  // cable visibly enters at the right, the index<->visual mapping is reversed
  // in this Harmony build — report it.
  function notesPortInfo(readPath) {
    try {
      var comp = findTopComposite();
      if (!comp) return "";
      var ports = node.numberOfInputPorts(comp);
      for (var i = 0; i < ports; i++) {
        if (node.srcNode(comp, i) === readPath) {
          return "port " + i + " of " + ports;
        }
      }
      return "not on " + shortName(comp);
    } catch (e) {
      return "";
    }
  }

  // Select the layer so it's highlighted in the Timeline / Node View.
  function revealLayer(readPath) {
    try {
      selection.clearSelection();
      selection.addNodeToSelection(readPath);
    } catch (e) { /* cosmetic only */ }
  }

  // Prefer a Composite directly under Top; fall back to any composite.
  function findTopComposite() {
    var comps = node.getNodes(["COMPOSITE"]);
    if (!comps || comps.length === 0) return "";
    for (var i = 0; i < comps.length; i++) {
      // "Top/Composite" splits into 2 parts -> directly under root
      if (String(comps[i]).split("/").length === 2) return comps[i];
    }
    return comps[0];
  }

  function uniqueColumnName(base) {
    if (columnFree(base)) return base;
    for (var i = 1; i < 1000; i++) {
      var candidate = base + "_" + i;
      if (columnFree(candidate)) return candidate;
    }
    return base + "_" + (new Date()).getTime();
  }

  // column.type returns "" for a non-existent column.
  function columnFree(name) {
    try { return column.type(name) === ""; }
    catch (e) { return true; }
  }

  // =======================================================================
  // DRAWING / FRAME HELPERS
  // =======================================================================

  // Earliest frame where drawingName is exposed on the timeline, or -1.
  function firstFrameOfDrawing(colName, drawingName) {
    var n = frame.numberOf();
    for (var f = 1; f <= n; f++) {
      if (column.getEntry(colName, 1, f) === drawingName) return f;
    }
    return -1;
  }

  // Next unused integer drawing name in the element.
  function nextDrawingName(colName) {
    var timings = column.getDrawingTimings(colName) || [];
    var max = 0;
    for (var i = 0; i < timings.length; i++) {
      var v = parseInt(timings[i], 10);
      if (!isNaN(v) && v > max) max = v;
    }
    return String(max + 1);
  }

  // Ensure a substitution STARTS at the given frame; return its drawing name.
  // Reuse only when a sub already begins exactly at this frame. If the frame
  // merely continues an earlier drawing's exposure, split it with a new sub —
  // per the brief: "creates a drawing substitution wherever the playhead is."
  function ensureSubstitutionAtFrame(layer, atFrame) {
    var here = column.getEntry(layer.column, 1, atFrame);
    var prev = (atFrame > 1) ? column.getEntry(layer.column, 1, atFrame - 1) : "";
    if (here && here !== "" && here !== prev) return here; // a sub starts here

    scene.beginUndoRedoAccum("SyncNote: add substitution");
    try {
      var name = nextDrawingName(layer.column);
      Drawing.create(layer.elementId, name, false);      // create empty drawing
      column.setEntry(layer.column, 1, atFrame, name);   // expose it here
      scene.endUndoRedoAccum();
      return name;
    } catch (e) {
      scene.endUndoRedoAccum();
      MessageBox.information("SyncNote: could not create substitution (" + e + ")");
      return "";
    }
  }

  // Every drawing in the element, plus any drawing that has notes,
  // each with its first exposed frame (-1 if not currently exposed).
  function collectGroups(layer, model) {
    var seen = {};
    var groups = [];

    var timings = column.getDrawingTimings(layer.column) || [];
    for (var i = 0; i < timings.length; i++) {
      var dn = timings[i];
      if (seen[dn]) continue;
      seen[dn] = true;
      groups.push({ drawing: dn, frame: firstFrameOfDrawing(layer.column, dn) });
    }

    var byEl = model.notesByDrawing[String(layer.elementId)] || {};
    for (var key in byEl) {
      if (byEl.hasOwnProperty(key) && !seen[key]) {
        seen[key] = true;
        groups.push({ drawing: key, frame: firstFrameOfDrawing(layer.column, key) });
      }
    }

    groups.sort(function (a, b) {
      if (a.frame < 0 && b.frame < 0) return 0;
      if (a.frame < 0) return 1;
      if (b.frame < 0) return -1;
      return a.frame - b.frame;
    });
    return groups;
  }

  // =======================================================================
  // UI  (native Qt widgets: resizable + scrollable, non-modal)
  //
  // IMPORTANT Qt-binding rule (this crashed v1 AND v2):
  //   Harmony's QBoxLayout binding exposes ONLY the exact 3-arg
  //   addWidget(QWidget, int stretch, Alignment) overload. The 1-arg form
  //   is hidden and a plain int does not convert to Alignment — the third
  //   argument must be a real Qt.Alignment value (evidence: openHarmony
  //   always calls addWidget(w, 0, Qt.AlignHCenter) and constructs flags
  //   with new Qt.WindowFlags(...)). Because this differs between engine
  //   versions, ALL adds go through addW() below, which discovers the
  //   working call form once and caches it.
  // =======================================================================

  var g_addWidgetMode = -1; // index of the first call form that worked

  // Add a widget to a box layout, tolerating binding differences between
  // Harmony versions. new Qt.Alignment(0) = "no alignment" = fill the cell.
  function addW(layout, widget, stretch) {
    if (stretch === undefined) stretch = 0;
    var attempts = [
      function () { layout.addWidget(widget, stretch, new Qt.Alignment(0)); }, // strict engines
      function () { layout.addWidget(widget, stretch, 0); },  // engines converting int->Alignment
      function () { layout.addWidget(widget); }                // permissive 1-arg binding
    ];
    if (g_addWidgetMode >= 0) { attempts[g_addWidgetMode](); return; }
    var lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      try { attempts[i](); g_addWidgetMode = i; return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  function mainWindow() {
    try {
      var tls = QApplication.topLevelWidgets();
      for (var i = 0; i < tls.length; i++) {
        if (tls[i] instanceof QMainWindow && !tls[i].parentWidget()) return tls[i];
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  // If a SyncNote panel is already open (even from a previous script engine),
  // close it — its signal connections may be dead, so a fresh one is safer.
  function closeExistingDialog() {
    try {
      var tls = QApplication.topLevelWidgets();
      for (var i = 0; i < tls.length; i++) {
        if (tls[i] && tls[i].objectName === DLG_NAME) {
          tls[i].close();
          tls[i].deleteLater();
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  function buildDialog(model, layer, connectStatus) {
    // Parenting to Harmony's main window keeps Qt (not the script engine's
    // garbage collector) in charge of the dialog's lifetime.
    var dlg = new QDialog(mainWindow());
    dlg.objectName = DLG_NAME;
    dlg.setWindowTitle("SyncNote " + SN_VERSION + "  —  " + scene.currentScene());
    dlg.minimumWidth = 380;
    dlg.minimumHeight = 520;

    var outer = new QVBoxLayout(dlg);

    // ---- toolbar row (container widget; see Qt-binding rule above) ----
    var toolbarW = new QWidget();
    var bar = new QHBoxLayout(toolbarW);
    bar.setContentsMargins(0, 0, 0, 0);
    var addBtn = new QPushButton("Add Note");
    addBtn.toolTip = "Create a substitution at the current playhead frame";
    var prevBtn = new QPushButton("◀");
    prevBtn.toolTip = "Go to the previous note frame";
    prevBtn.maximumWidth = 36;
    var nextBtn = new QPushButton("▶");
    nextBtn.toolTip = "Go to the next note frame";
    nextBtn.maximumWidth = 36;
    addW(bar, addBtn, 1);
    addW(bar, prevBtn);
    addW(bar, nextBtn);
    addW(outer, toolbarW);

    // ---- scrolling list (QScrollArea expands by default -> fills window) ----
    var scroll = new QScrollArea();
    scroll.widgetResizable = true;
    var host = new QWidget();
    var listLayout = new QVBoxLayout(host);
    listLayout.setContentsMargins(4, 4, 4, 4);
    listLayout.setSpacing(8);
    scroll.setWidget(host);
    addW(outer, scroll, 1);

    // ---- status bar: exactly what SyncNote is bound to, and whether the
    // Notes node made it into the render path. If something looks wrong in
    // the scene, this line says why. ----
    var statusLbl = new QLabel(
      "Layer: " + layer.node + "   •   element #" + layer.elementId +
      "   •   " + (connectStatus || "") +
      "   •   " + notesPortInfo(layer.node) + "   •   v" + SN_VERSION);
    statusLbl.styleSheet = "color: gray; font-size: 10px;";
    statusLbl.wordWrap = true;
    addW(outer, statusLbl);

    // ---- staleness state (v0.10.0) ----
    var shownSig = "";    // drawing:frame signature of what's displayed
    var drafts = {};      // unsaved input text, preserved across rebuilds
    var liveInputs = {};  // drawingName -> its QTextEdit in the current build
    var staleTimer = null;
    var lastSignal = "";  // which notifier signal requested the last check

    // Signature of the live timeline state the list depends on.
    function groupsSignature() {
      var groups = collectGroups(layer, model);
      var parts = [];
      for (var i = 0; i < groups.length; i++) {
        parts.push(groups[i].drawing + ":" + groups[i].frame);
      }
      return parts.join("|");
    }

    function refresh() {
      // Rebuilding the list resets the scroll position — remember it so
      // adding a note deep in the list doesn't yank the view around.
      var savedScroll = 0;
      try { savedScroll = scroll.verticalScrollBar().value; } catch (e) {}

      // Stash half-typed notes so an auto-refresh can't eat a draft.
      try {
        for (var dn in liveInputs) {
          if (!liveInputs.hasOwnProperty(dn)) continue;
          var draft = "";
          try { draft = String(liveInputs[dn].plainText); } catch (e) {}
          if (draft.replace(/^\s+|\s+$/g, "") !== "") drafts[dn] = draft;
        }
      } catch (e) { /* drafts are best-effort */ }
      liveInputs = {};

      g_snKeepAlive = []; // old cards (and their filters) are torn down below
      clearLayout(listLayout);

      var groups = collectGroups(layer, model);
      for (var i = 0; i < groups.length; i++) {
        addW(listLayout, makeGroupWidget(groups[i]));
      }
      if (groups.length === 0) {
        var hint = new QLabel("No notes yet.\nMove the playhead and click “Add Note”.");
        hint.wordWrap = true;
        addW(listLayout, hint);
      }
      // Expanding spacer widget packs rows to the top, SyncSketch-style.
      // (Safer than addStretch(), which has its own binding quirks.)
      addW(listLayout, new QWidget(), 1);

      shownSig = groupsSignature(); // what the panel now reflects
      restoreScroll(savedScroll);
    }

    // Put the scrollbar back where it was: once immediately, and once after
    // a short delay — the immediate set can be clamped because the rebuilt
    // list hasn't been measured yet. (Parented QTimer so it isn't GC'd;
    // same pattern openHarmony uses for its toasts.)
    function restoreScroll(v) {
      if (!v) return;
      try { scroll.verticalScrollBar().value = v; } catch (e) {}
      try {
        var t;
        try { t = new QTimer(dlg); }
        catch (e1) { t = new QTimer(); }
        g_snKeepAlive.push(t);
        t.singleShot = true;
        t.timeout.connect(function () {
          try { scroll.verticalScrollBar().value = v; } catch (e) {}
        });
        t.start(50);
      } catch (e) { /* immediate restore above already did its best */ }
    }

    // One substitution group: clickable frame header + notes + inline adder.
    // The FRAME is the group's identity (what students care about); the sub
    // number is shown as metadata on each note card instead.
    function makeGroupWidget(group) {
      var drawingName = group.drawing;
      var frameNo = group.frame;

      var box = new QFrame();
      box.frameShape = QFrame.StyledPanel;
      var v = new QVBoxLayout(box);

      // Header: green clickable "Frame 009" link (padded to scene length
      // digits). Link-based navigation is deliberate: card-wide click
      // filters worked but felt unreliable (user call, v0.8.3) — links are
      // handled natively by QLabel with no GC/event-propagation caveats.
      if (frameNo > 0) {
        var head = new QLabel(
          '<a href="#" style="' + LINK_STYLE + ' font-weight:bold;">Frame ' +
          padFrame(frameNo) + "</a>");
        head.toolTip = "Go to Frame " + frameNo;
        head.linkActivated.connect(makeJumpToSub(drawingName, frameNo));
        addW(v, head);
      } else {
        var deadHead = new QLabel("(not exposed on timeline)  •  Sub " + drawingName);
        deadHead.styleSheet = "color: gray;";
        addW(v, deadHead);
      }

      // Existing notes.
      var notes = notesFor(model, layer.elementId, drawingName);
      for (var i = 0; i < notes.length; i++) {
        addW(v, makeNoteCard(drawingName, frameNo, notes[i]));
      }

      // Inline "add note" row: multiline box that wraps and grows.
      // Enter submits; Shift+Enter inserts a newline (Discord/Slack-style).
      var addRowW = new QWidget();
      var addRow = new QHBoxLayout(addRowW);
      addRow.setContentsMargins(0, 0, 0, 0);
      var input = new QTextEdit();
      try { input.placeholderText = "Add a note…  (Enter = save, Shift+Enter = new line)"; }
      catch (e) { /* placeholder not bound in some engines; cosmetic */ }
      liveInputs[drawingName] = input;
      if (drafts[drawingName]) { // restore text an auto-refresh interrupted
        try { input.plainText = drafts[drawingName]; } catch (e) {}
        delete drafts[drawingName];
      }
      sizeNoteInput(input);
      var noteBtn = new QPushButton("Add");
      addW(addRow, input, 1);
      addW(addRow, noteBtn);
      addW(v, addRowW);

      function commit() {
        var txt = "";
        try { txt = String(input.plainText); } catch (e) {}
        txt = txt.replace(/^\s+|\s+$/g, "");
        if (txt === "") return;
        addNote(model, layer.elementId, drawingName, txt);
        saveModel(model);
        // Empty the box before refresh so the draft-stash doesn't re-save
        // the just-committed text as an unsaved draft.
        try { input.plainText = ""; } catch (e) {}
        delete drafts[drawingName];
        refresh();
      }
      noteBtn.clicked.connect(commit);

      // Enter handling, primary path: event filter (consumes the key).
      var filter = makeEnterFilter(commit);
      if (filter) {
        try { input.installEventFilter(filter); } catch (e) { filter = null; }
      }

      // Enter handling, fallback path + auto-grow: if the filter is inert,
      // a plain Enter lands as a trailing newline in the text — detect it,
      // check Shift via the live keyboard state, and submit.
      input.textChanged.connect(function () {
        sizeNoteInput(input);
        try {
          var t = String(input.plainText);
          if (t.length > 0 && t.charAt(t.length - 1) === "\n") {
            var shiftHeld = false;
            try {
              shiftHeld = (QApplication.keyboardModifiers() & Qt.ShiftModifier) != 0;
            } catch (e) { /* can't read modifiers; treat Enter as submit */ }
            if (!shiftHeld) commit(); // commit trims the trailing newline
          }
        } catch (e) { /* typing must never break */ }
      });

      return box;
    }

    // A single note card: "date • Sub N" meta line + text + delete.
    // "Sub N" is a jump link, same as the group header.
    function makeNoteCard(drawingName, frameNo, note) {
      var card = new QFrame();
      card.frameShape = QFrame.StyledPanel;
      var h = new QHBoxLayout(card);

      var textColW = new QWidget();
      var textCol = new QVBoxLayout(textColW);
      textCol.setContentsMargins(0, 0, 0, 0);

      var metaHtml = '<span style="color:gray; font-size:10px;">' +
                     relativeDate(note) + "   •   </span>";
      if (frameNo > 0) {
        metaHtml += '<a href="#" style="' + LINK_STYLE + ' font-size:10px;">Sub ' +
                    drawingName + "</a>";
      } else {
        metaHtml += '<span style="color:gray; font-size:10px;">Sub ' +
                    drawingName + "</span>";
      }
      var meta = new QLabel(metaHtml);
      if (frameNo > 0) meta.linkActivated.connect(makeJumpToSub(drawingName, frameNo));
      addW(textCol, meta);

      var textLbl = new QLabel(note.text);
      textLbl.wordWrap = true;
      // Selectable + copyable (drag to select, Ctrl+C / right-click Copy).
      // Because the label now accepts mouse events, clicks on the text do
      // NOT bubble to the card's jump filter — selection stays safe.
      try { textLbl.textInteractionFlags = Qt.TextSelectableByMouse; }
      catch (e) { /* engine refused the flag; text stays non-selectable */ }
      addW(textCol, textLbl);
      addW(h, textColW, 1);

      var delBtn = new QPushButton("✕");
      delBtn.toolTip = "Delete note";
      delBtn.maximumWidth = 28;
      delBtn.clicked.connect((function (nid, dn) {
        return function () {
          deleteNote(model, layer.elementId, dn, nid);
          saveModel(model);
          refresh();
        };
      })(note.id, drawingName));
      addW(h, delBtn);

      return card;
    }

    // Jump by DRAWING, not by a frame captured at build time: the sub's
    // first frame is recomputed at click time, so a sub moved on the
    // timeline still navigates correctly — and if the recomputed frame
    // disagrees with what the card shows, the display heals itself.
    function makeJumpToSub(dn, shownFrame) {
      return function () {
        var f = firstFrameOfDrawing(layer.column, dn);
        if (f > 0) frame.setCurrent(f);
        if (f !== shownFrame) refresh(); // display was stale
      };
    }

    // Multiline note box sizing: wrap + grow with content (cap, then scroll).
    // Falls back to a fixed 2-line height if document metrics aren't bound.
    function sizeNoteInput(edit) {
      var h = 44;
      try {
        var doc = null;
        try { doc = edit.document(); } catch (e0) { doc = edit.document; }
        var s = doc.size;
        var dh = (typeof s.height === "function") ? s.height() : s.height;
        if (dh && dh > 0) h = Math.ceil(dh) + 12;
      } catch (e) { /* keep fallback height */ }
      if (h < 44) h = 44;
      if (h > 160) h = 160; // ~8 lines, then the box scrolls internally
      edit.minimumHeight = h;
      edit.maximumHeight = h;
    }

    // Event filter so Enter submits and Shift+Enter inserts a newline.
    // Returns null if this engine can't build QObject-based filters — the
    // textChanged fallback in makeGroupWidget covers that case.
    function makeEnterFilter(commitFn) {
      try {
        var f = new QObject(dlg);
        f.eventFilter = function (watched, event) {
          try {
            if (event.type() === QEvent.KeyPress) {
              var k = event.key();
              if (k === Qt.Key_Return || k === Qt.Key_Enter) {
                if (event.modifiers() & Qt.ShiftModifier) return false; // newline
                commitFn();
                return true; // consume: Enter = save note
              }
            }
          } catch (e) { /* never block typing */ }
          return false;
        };
        g_snKeepAlive.push(f); // pin the wrapper or GC kills the override
        return f;
      } catch (e) {
        return null;
      }
    }

    addBtn.clicked.connect(function () {
      var f = frame.current();
      var drawingName = ensureSubstitutionAtFrame(layer, f);
      if (drawingName) refresh(); // group appears; type the note in its field
    });

    // Scrub the playhead between note frames, anchored to wherever the
    // playhead currently is (frames recomputed live so new subs count).
    function scrubToNoteFrame(dir) {
      var f = frame.current();
      var groups = collectGroups(layer, model);
      var best = -1;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i].frame;
        if (g <= 0) continue;
        if (dir > 0 && g > f && (best < 0 || g < best)) best = g;
        if (dir < 0 && g < f && (best < 0 || g > best)) best = g;
      }
      if (best > 0) frame.setCurrent(best); // no next/prev note: do nothing
    }
    prevBtn.clicked.connect(function () { scrubToNoteFrame(-1); });
    nextBtn.clicked.connect(function () { scrubToNoteFrame(1); });

    // ---- auto-refresh (v0.10.0) ----
    // SceneChangeNotifier.columnValuesChanged fires whenever exposure data
    // changes (e.g. a sub dragged to another frame in the timeline). We
    // debounce it, then rebuild ONLY if the displayed frames actually went
    // stale — so our own writes (already followed by refresh) and unrelated
    // column edits are no-ops, and typing is never interrupted needlessly.
    function scheduleStalenessCheck() {
      try {
        if (!staleTimer) {
          try { staleTimer = new QTimer(dlg); }
          catch (e0) { staleTimer = new QTimer(); }
          staleTimer.singleShot = true;
          staleTimer.timeout.connect(function () {
            try {
              if (groupsSignature() !== shownSig) {
                trace("timeline changed under the panel (via " + lastSignal +
                      ") — auto-refreshing");
                refresh();
              }
            } catch (e) { /* never break the session */ }
          });
          g_snKeepAlivePanel.push(staleTimer); // survives refreshes
        }
        staleTimer.stop();
        staleTimer.start(300);
      } catch (e) { /* auto-refresh unavailable; click self-heal covers it */ }
    }

    // No column filtering (v0.10.1): the signal may carry internal column
    // names that don't match ours, which silently killed auto-refresh in
    // v0.10.0. False alarms are free — the staleness check only rebuilds
    // when the displayed frames genuinely changed — so listen broadly and
    // let the signature comparison be the gatekeeper.
    var colSignalLogged = false;
    function onTimelineMaybeChanged(signalName) {
      lastSignal = signalName;
      scheduleStalenessCheck();
    }

    try {
      var notifier = new SceneChangeNotifier(dlg); // dies with the panel
      notifier.columnValuesChanged.connect(function (cols) {
        try {
          if (!colSignalLogged) { // one-time: learn the internal column names
            colSignalLogged = true;
            var names = [];
            try {
              for (var i = 0; i < cols.length; i++) names.push(String(cols[i]));
            } catch (e0) { names.push("(uninspectable)"); }
            trace("columnValuesChanged fired; columns: " + names.join(", ") +
                  "  (our column: " + layer.column + ")");
          }
        } catch (e) { /* diagnostics only */ }
        onTimelineMaybeChanged("columnValuesChanged");
      });
      // Belt and suspenders: exposure drags may surface as other signals,
      // and currentFrameChanged guarantees reconciliation on the very next
      // playhead touch even if an edit emits nothing we recognize.
      try {
        notifier.sceneChanged.connect(function () {
          onTimelineMaybeChanged("sceneChanged");
        });
      } catch (e1) { /* signal not bound in this engine */ }
      try {
        notifier.currentFrameChanged.connect(function () {
          onTimelineMaybeChanged("currentFrameChanged");
        });
      } catch (e2) { /* signal not bound in this engine */ }
      g_snKeepAlivePanel.push(notifier); // pin: script QObject, GC rules apply
      trace("SceneChangeNotifier active — listening: columnValuesChanged, " +
            "sceneChanged, currentFrameChanged");
    } catch (e) {
      trace("SceneChangeNotifier unavailable (" + e + ") — falling back to " +
            "click-time self-heal only");
    }

    refresh();
    dlg.show();
    dlg.raise();
    dlg.activateWindow();
  }

  // =======================================================================
  // UTILITIES
  // =======================================================================
  function clearLayout(layout) {
    if (!layout) return;
    var item = layout.takeAt(0);
    while (item) {
      var w = item.widget();
      if (w) { w.hide(); w.deleteLater(); }
      var child = item.layout();
      if (child) clearLayout(child);
      item = layout.takeAt(0);
    }
  }

  function shortName(nodePath) {
    var parts = String(nodePath).split("/");
    return parts[parts.length - 1];
  }

  function pad(num, width) {
    var s = String(num);
    while (s.length < width) s = "0" + s;
    return s;
  }

  // Frame numbers padded to the scene's length: 60 frames -> 2 digits,
  // 300 frames -> 3 digits, etc.
  function padFrame(f) {
    return pad(f, String(frame.numberOf()).length);
  }

  // Dump the composite input port map to the Message Log — passive
  // diagnostics for the backburnered "Notes lands at the back" issue.
  function logPortMap() {
    try {
      var comp = findTopComposite();
      if (!comp) return;
      var ports = node.numberOfInputPorts(comp);
      var lines = ["SyncNote " + SN_VERSION + " — port map of " + comp + ":"];
      for (var i = 0; i < ports; i++) {
        lines.push("   port " + i + "  <-  " + node.srcNode(comp, i));
      }
      MessageLog.trace(lines.join("\n"));
    } catch (e) { /* diagnostics must never break the run */ }
  }

  // Qt Script's Date() returns NaN for ISO-8601 strings (the "NaN-NaN-NaN"
  // bug), so new notes carry a numeric `ts`; for notes saved by older builds
  // we hand-parse the ISO date string.
  function noteTime(note) {
    if (note && note.ts) return note.ts;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec((note && note.date) || "");
    if (m) {
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                      Number(m[4]), Number(m[5]), Number(m[6]));
    }
    return NaN;
  }

  // "just now" / "5 minutes ago" / "15 days ago" / fallback to date.
  function relativeDate(note) {
    try {
      var then = noteTime(note);
      if (isNaN(then)) return "";
      var secs = Math.floor(((new Date()).getTime() - then) / 1000);
      if (secs < 45) return "just now";
      var mins = Math.floor(secs / 60);
      if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
      var days = Math.floor(hrs / 24);
      if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
      var d = new Date(then); // numeric constructor works everywhere
      return d.getFullYear() + "-" + pad(d.getMonth() + 1, 2) + "-" + pad(d.getDate(), 2);
    } catch (e) {
      return "";
    }
  }
}
