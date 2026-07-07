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
var g_snNotesDirty = false;  // notes changed since the scene was last saved —
                             // module-level so it survives panel relaunches

// Title-bar window icon, embedded as base64 PNG so the script is a single
// self-contained file (no separate SyncNote.png required). Injected from
// _icon/_exports/Icon.png. If the decode bindings misbehave on some build,
// buildDialog falls back to a SyncNote.png on disk, then to Harmony's
// default icon — the icon is always purely cosmetic.
var SN_ICON_B64 = "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";

function SyncNote() {
  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  var SN_VERSION    = "0.28.1";          // embedded window icon + mid-line Enter-save fix
  var SN_EMPTY_TVG_BYTES = 1024;         // files at/below this = blank drawing (see KB §28)
  var META_KEY      = "SyncNote";        // scene-metadata key holding our JSON model
  var META_TYPE     = "string";
  var MODEL_VERSION = 1;
  var LAYER_NAME    = "Notes";           // default name for the review layer
  var DLG_NAME      = "SyncNoteDialog";  // objectName used to find/replace open panels
  var tlScrollbar     = null;  // cached Timeline horizontal scrollbar (per launch)
  var tlActionsDumped = false; // one-time diagnostic guard
  var SN_GREEN      = "#4CAF50";         // the SyncNote green (links, check circles)
  var LINK_STYLE    = "color:" + SN_GREEN + "; text-decoration:none;";

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
    trace("connection: " + connectStatus); // verdict lives in the Message Log
    applyNotesColor(layer.node); // paint it SyncNote green, every run

    model.syncNoteElementId = layer.elementId;
    saveModel(model);

    // Silent launch sweep (v0.23.0): abandoned Add Note subs (no notes, no
    // art) disappear before the panel builds. Runs before the first-use
    // check so a fully swept scene behaves like first use again.
    sweepAbandonedSubs(layer, model);

    // First use ONLY (layer has no subs yet): create a starter substitution
    // at the playhead so a new user has something to type into. On every
    // later launch, opening the panel creates nothing — the Add Note button
    // is the only thing that makes subs (v0.13.0; launching on a random
    // frame used to leave stray empty subs).
    var existingTimings = [];
    try { existingTimings = column.getDrawingTimings(layer.column) || []; }
    catch (e) { /* treat as first use */ }
    if (existingTimings.length === 0) {
      ensureSubstitutionAtFrame(layer, frame.current());
    }

    revealLayer(layer.node); // select it so it's obvious in Timeline/Node View

    buildDialog(model, layer);
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
    g_snNotesDirty = true; // cleared by the save-on-close in buildDialog
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
      done: false, // checklist state; notes from older builds lack this = unchecked
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

    // 4) Neither order satisfied the measurement. CRITICAL: do not leave
    // the LOSING order in place (v0.9.1..v0.14.x did — the last strategy
    // tried was Notes-first, i.e. the BACK port, so failing scenes got
    // actively parked at the back). Re-apply the empirically-front order
    // (Notes on last port), then report honestly.
    reorderComposite(readPath, comp, false);
    logCompositionOrder();
    logPortMap();
    rank = renderRank(readPath);
    return "left on last port (usually front) — render check disagrees " +
           "(rank " + rank + "); diagnostics in Message Log";
  }

  // Notes' place in the real render stack: 0 = frontmost layer,
  // N = that many layers render in front of it, -2 = unmeasurable.
  //
  // Group-scene gotcha (found in a rigged scene): the composition also
  // enumerates nodes INSIDE groups, ordered by group traversal — ~45 rig
  // drawings "ahead" of Notes no matter the port order, so verification
  // could never pass. Fix: only TOP-LEVEL items compete (depth 0 per
  // CompositionItem.depth) — READ layers and GROUPs (a group ahead of
  // Notes means its whole rig draws in front, so it counts as one layer).
  function renderRank(readPath) {
    try {
      var order = compositionOrder.buildDefaultCompositionOrder();
      if (!order || order.length === undefined) return -2;
      var ahead = 0;
      for (var i = 0; i < order.length; i++) {
        var n = "";
        try { n = String(order[i].node); } catch (e0) { continue; }
        if (n === readPath) return ahead;
        var depth = 0;
        try { depth = Number(order[i].depth) || 0; } catch (e1) {}
        if (depth > 0) continue; // inside a group: not a top-level layer
        try {
          var t = node.type(n);
          if (t === "READ" || t === "GROUP") ahead++;
        } catch (e2) { /* unreadable node; don't count it */ }
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

  // ---- Timeline follow (v0.11.0) -----------------------------------------
  // frame.setCurrent() moves the playhead but does NOT scroll the Timeline
  // view, so a jump to an off-screen frame leaves the user staring at the
  // wrong part of the timeline. No documented action does "center on current
  // frame", so we drive the Timeline's own horizontal scrollbar directly:
  // zoom is untouched by construction (only the scroll position moves), and
  // we don't move anything if the frame is already visible.

  // Locate the Timeline view's FRAMES-AREA horizontal scrollbar.
  //
  // v0.11.0 gotcha: the Timeline has (at least) two horizontal scrollbars —
  // the layer-name column's and the frames area's. Grabbing the first
  // "timeline-ish" one found the wrong bar (range 0), and the scroll became
  // a silent no-op. Now every candidate is collected and the one with the
  // LARGEST scroll range wins — when zoomed in, that's the frames area by a
  // huge margin. The cache is revalidated by range, not mere existence.
  function findTimelineScrollbar() {
    try {
      if (tlScrollbar && Number(tlScrollbar.maximum) > 0) return tlScrollbar;
    } catch (e) { /* cached widget destroyed or unreadable */ }
    tlScrollbar = null;
    try {
      var all = QApplication.allWidgets();
      var candidates = 0;
      var best = null;
      var bestRange = 0;
      for (var i = 0; i < all.length; i++) {
        var w = all[i];
        try {
          var isSB = false;
          try { isSB = (w instanceof QScrollBar); } catch (e0) {}
          if (!isSB) {
            try {
              isSB = String(w.metaObject().className())
                       .toLowerCase().indexOf("scrollbar") >= 0;
            } catch (e1) {}
          }
          if (!isSB) continue;
          if (Number(w.orientation) !== 1) continue; // Qt.Horizontal

          var isTimeline = false;
          var p = w;
          for (var hops = 0; p && hops < 8; hops++) {
            var tag = "";
            try { tag = String(p.objectName).toLowerCase(); } catch (e2) {}
            try { tag += " " + String(p.metaObject().className()).toLowerCase(); }
            catch (e3) {}
            if (tag.indexOf("timeline") >= 0) { isTimeline = true; break; }
            p = p.parentWidget();
          }
          if (!isTimeline) continue;

          candidates++;
          var range = 0;
          try { range = Number(w.maximum); } catch (e4) {}
          if (range > bestRange) { bestRange = range; best = w; }
        } catch (e5) { /* try the next widget */ }
      }
      if (best && bestRange > 0) {
        tlScrollbar = best;
        trace("Timeline frames scrollbar located (" + candidates +
              " candidate(s); picked range " + bestRange + ")");
        return best;
      }
      if (candidates > 0) {
        // All ranges are 0: the whole scene fits on screen — nothing to
        // scroll. Not an error; stay quiet and try again next jump.
        return null;
      }
    } catch (e6) { /* fall through */ }
    dumpTimelineActionsOnce(); // genuinely found nothing timeline-ish
    return null;
  }

  // Scroll the Timeline so `f` is visible (roughly centered); keep zoom.
  function scrollTimelineToFrame(f) {
    try {
      var sb = findTimelineScrollbar(); // null = nothing to scroll / not found
      if (!sb) return;
      var total = frame.numberOf();
      if (total < 2) return;
      var max = Number(sb.maximum);
      var page = Number(sb.pageStep);
      var span = max + page; // full content width in scrollbar units
      if (span <= 0 || max <= 0) return; // nothing to scroll (fits on screen)

      // Approximate currently-visible frame range; if f is comfortably
      // inside it, leave the user's view alone.
      var val = Number(sb.value);
      var visStart = (val / span) * total;
      var visEnd = ((val + page) / span) * total;
      if (f >= visStart + 1 && f <= visEnd - 1) return;

      var target = Math.round(((f - 0.5) / total) * span - page / 2);
      var min = Number(sb.minimum);
      if (target < min) target = min;
      if (target > max) target = max;
      sb.value = target;
      trace("Timeline scrolled to show frame " + f);
    } catch (e) { /* navigation must never break */ }
  }

  // Round-two diagnostics if the scrollbar hunt fails on some build: what
  // frame/scroll/center-ish actions does the Timeline view actually offer?
  function dumpTimelineActionsOnce() {
    if (tlActionsDumped) return;
    tlActionsDumped = true;
    try {
      var acts = Action.getActionList("timelineView");
      var hits = [];
      for (var i = 0; i < acts.length; i++) {
        var a = String(acts[i]).toLowerCase();
        if (a.indexOf("frame") >= 0 || a.indexOf("scroll") >= 0 ||
            a.indexOf("center") >= 0 || a.indexOf("focus") >= 0) {
          hits.push(String(acts[i]));
        }
      }
      trace("Timeline scrollbar NOT found. timelineView actions (filtered): " +
            (hits.length ? hits.join(", ") : "(none matched)"));
    } catch (e) {
      trace("Timeline scrollbar NOT found; Action.getActionList failed (" + e + ")");
    }
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

  // Paint the Notes node in the SyncNote green (#4CAF50) so it's instantly
  // recognizable in the Node View and Timeline. Applied on every launch —
  // idempotent, and it heals scenes from pre-color builds or manual resets.
  function applyNotesColor(readPath) {
    try {
      node.setColor(readPath, new ColorRGBA(76, 175, 80, 255)); // = SN_GREEN
    } catch (e) {
      trace("could not set the Notes node colour (" + e + ")");
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

  // Remove a substitution's exposure from the timeline, as if it was never
  // added: every frame showing it is re-keyed to the drawing that was
  // exposed just before its span (so earlier exposure extends across the
  // gap), or cleared when nothing came before. One undo step. The drawing
  // file stays in the element (harmless; hidden by collectGroups once it
  // has no exposure and no notes).
  // Core exposure removal WITHOUT undo bracketing, so callers can batch
  // several removals into a single undo step (the launch sweep does).
  function removeSubstitutionCore(layer, drawingName) {
    var n = frame.numberOf();
    var prev = ""; // drawing exposed just before the current span
    for (var f = 1; f <= n; f++) {
      var cur = column.getEntry(layer.column, 1, f);
      if (cur === drawingName) {
        column.setEntry(layer.column, 1, f, prev); // "" clears the cell
        // prev intentionally NOT updated: keep extending the pre-span
        // drawing over the whole span (and over any redundant keys).
      } else {
        prev = cur;
      }
    }
  }

  function removeSubstitution(layer, drawingName) {
    scene.beginUndoRedoAccum("SyncNote: remove substitution");
    try {
      removeSubstitutionCore(layer, drawingName);
      scene.endUndoRedoAccum();
      return true;
    } catch (e) {
      scene.endUndoRedoAccum();
      return false;
    }
  }

  // Size of a drawing's file on disk, or -1 when unreadable. There is NO
  // is-drawing-empty API (checked, KB §28), so blank-vs-drawn is judged by
  // file size: Drawing.create blanks are a few hundred bytes, brushwork
  // adds kilobytes. NOTE: reflects the SAVED state — art drawn without the
  // scene ever saving is invisible here (save-on-close makes this rare).
  function drawingArtBytes(elementId, drawingName) {
    var path = "";
    try { path = String(Drawing.filename(elementId, drawingName)); } catch (e) { return -1; }
    if (!path) return 0; // no file at all: nothing drawn, nothing to lose
    try { return Number(new QFileInfo(path).size()); } catch (e0) {}
    try { return Number(new File(path).size); } catch (e1) {}
    return -1; // can't read: caller must treat as "has art" and keep it
  }

  // Launch sweep (v0.23.0, silent by user choice): subs with zero notes
  // AND zero artwork are accidents of the Add Note button — remove their
  // exposure. AND, never OR: notes-without-art and art-without-notes are
  // both legitimate review content. One undo step for the whole sweep;
  // drawing files are never deleted, so a false positive can't cost art.
  function sweepAbandonedSubs(layer, model) {
    var timings = [];
    try { timings = column.getDrawingTimings(layer.column) || []; } catch (e) { return; }
    var doomed = [];
    for (var i = 0; i < timings.length; i++) {
      var name = String(timings[i]);
      if (notesFor(model, layer.elementId, name).length > 0) continue; // has notes
      var bytes = drawingArtBytes(layer.elementId, name);
      if (bytes < 0 || bytes > SN_EMPTY_TVG_BYTES) {
        trace("sweep: sub " + name + " kept (" +
              (bytes < 0 ? "size unreadable" : bytes + " bytes of art") + ")");
        continue;
      }
      trace("sweep: sub " + name + " is empty (" + bytes + " bytes, no notes)");
      doomed.push(name);
    }
    if (doomed.length === 0) return;

    scene.beginUndoRedoAccum("SyncNote: sweep empty subs");
    try {
      for (var d = 0; d < doomed.length; d++) {
        removeSubstitutionCore(layer, doomed[d]);
        try {
          var eid = String(layer.elementId);
          if (model.notesByDrawing[eid]) delete model.notesByDrawing[eid][doomed[d]];
        } catch (e0) { /* empty-array key tidy-up only */ }
      }
      scene.endUndoRedoAccum();
    } catch (e1) {
      scene.endUndoRedoAccum();
    }
    trace("sweep: removed " + doomed.length + " abandoned sub(s): " + doomed.join(", "));
  }

  // Erase the drawn content of EVERY sub in the Notes element — all four
  // art layers (0 underlay, 1 colour, 2 line, 3 overlay) per drawing via
  // DrawingTools.clearArt. Scoped to our element ID by construction, so
  // student artwork is untouchable. Config format is verified in docs but
  // new in practice: tries a Drawing.Key first, then a plain object, and
  // traces the tally so a refusing engine is visible in the Message Log.
  function clearAllSubArt(layer) {
    var timings = [];
    try { timings = column.getDrawingTimings(layer.column) || []; } catch (e) {}
    var cleared = 0;
    var failed = 0;
    for (var i = 0; i < timings.length; i++) {
      var name = String(timings[i]);
      for (var art = 0; art <= 3; art++) {
        var ok = false;
        try {
          var key = null;
          try { key = Drawing.Key({ elementId: layer.elementId, exposure: name }); }
          catch (e0) { key = { elementId: layer.elementId, exposure: name }; }
          ok = DrawingTools.clearArt({ drawing: key, art: art });
        } catch (e1) {
          try {
            ok = DrawingTools.clearArt({
              drawing: { elementId: layer.elementId, exposure: name },
              art: art
            });
          } catch (e2) { ok = false; }
        }
        if (ok) cleared++; else failed++;
      }
    }
    trace("clearAllSubArt: " + cleared + " art layer(s) cleared" +
          (failed ? ", " + failed + " FAILED (see KB §26 if this persists)" : ""));
  }

  // Remove ALL exposure from the Notes column — used by Clear Both for a
  // full reset. (Drawing files stay in the element; with no exposure and
  // no notes they're hidden from the panel and render nothing.)
  function clearAllExposure(layer) {
    try {
      var n = frame.numberOf();
      for (var f = 1; f <= n; f++) {
        try { column.setEntry(layer.column, 1, f, ""); } catch (e) {}
      }
    } catch (e) { /* caller's undo accum still closes */ }
  }

  // One pass over the whole Notes column: first AND last exposed frame per
  // drawing (v0.26.0) — cheaper than the old per-drawing scans, and the
  // last frame feeds the "Frame 42 - 43" range headers + the staleness
  // signature (so exposure-length changes auto-refresh the panel).
  function exposureMap(colName) {
    var map = {};
    var n = frame.numberOf();
    for (var f = 1; f <= n; f++) {
      var d = "";
      try { d = column.getEntry(colName, 1, f); } catch (e) { continue; }
      if (!d || d === "") continue;
      if (!map[d]) map[d] = { first: f, last: f };
      else map[d].last = f;
    }
    return map;
  }

  // Every drawing in the element, plus any drawing that has notes, each
  // with its first/last exposed frames (-1 if not currently exposed).
  function collectGroups(layer, model) {
    var seen = {};
    var groups = [];
    var exp = exposureMap(layer.column);

    var timings = column.getDrawingTimings(layer.column) || [];
    for (var i = 0; i < timings.length; i++) {
      var dn = timings[i];
      if (seen[dn]) continue;
      seen[dn] = true;
      var e1 = exp[dn];
      // A drawing with no exposure AND no notes carries no information —
      // hide it instead of cluttering the list with "(not exposed)" cards.
      if (!e1 && notesFor(model, layer.elementId, dn).length === 0) continue;
      groups.push({ drawing: dn, frame: e1 ? e1.first : -1, last: e1 ? e1.last : -1 });
    }

    var byEl = model.notesByDrawing[String(layer.elementId)] || {};
    for (var key in byEl) {
      if (!byEl.hasOwnProperty(key) || seen[key]) continue;
      if (!byEl[key] || byEl[key].length === 0) continue; // no actual notes
      seen[key] = true;
      var e2 = exp[key];
      groups.push({ drawing: key, frame: e2 ? e2.first : -1, last: e2 ? e2.last : -1 });
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
          // Mark as an internal close (relaunch): the old panel's
          // save-on-close must not fire — the new panel takes over.
          try { tls[i].setProperty("snSilentClose", true); } catch (e) {}
          tls[i].close();
          tls[i].deleteLater();
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  function buildDialog(model, layer) {
    // Parenting to Harmony's main window keeps Qt (not the script engine's
    // garbage collector) in charge of the dialog's lifetime.
    var dlg = new QDialog(mainWindow());
    dlg.objectName = DLG_NAME;
    dlg.setWindowTitle("SyncNote " + SN_VERSION + "  —  " + scene.currentScene());
    dlg.minimumWidth = 380;
    dlg.minimumHeight = 520;

    // Custom title-bar icon (v0.28.0). Primary: decode the embedded base64
    // PNG (self-contained — no external file). Fallback: a SyncNote.png on
    // disk beside the script. Either failing just leaves Harmony's default
    // icon — purely cosmetic.
    try {
      var icon = null;

      // 1) embedded base64 → QPixmap → QIcon
      try {
        if (SN_ICON_B64 && SN_ICON_B64.charAt(0) !== "_") { // not the placeholder
          var raw = new QByteArray(SN_ICON_B64);
          var bin = QByteArray.fromBase64(raw);
          var pix = new QPixmap();
          if (pix.loadFromData(bin) && !pix.isNull()) icon = new QIcon(pix);
        }
      } catch (eEmbed) { trace("embedded icon decode failed (" + eEmbed + ")"); }

      // 2) fallback: SyncNote.png in the scripts folder
      if (!icon) {
        try {
          var iconPath = String(specialFolders.userScripts) + "/SyncNote.png";
          if (new QFileInfo(iconPath).exists()) icon = new QIcon(iconPath);
        } catch (eFile) {}
      }

      if (icon) dlg.setWindowIcon(icon);
      else trace("no window icon available; using Harmony default");
    } catch (e) { trace("could not set window icon (" + e + ")"); }

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

    // ---- bottom row: stats on the left, bulk actions on the right (one
    // row, per user sketch). Connection/render verdicts live in the
    // Message Log.
    var bottomW = new QWidget();
    var bottom = new QHBoxLayout(bottomW);
    bottom.setContentsMargins(0, 8, 0, 0); // breathing room above the strip
    bottom.setSpacing(8); // ...and between stats and buttons
    // Non-breaking spaces INSIDE each stat phrase: QLabel otherwise wraps
    // at any space, splitting phrases like "port 6 / of 7" mid-thought.
    // Wraps now happen only at the bullet separators.
    // NOTE: the replacement string below is a LITERAL U+00A0 (non-breaking
    // space) — it looks identical to a plain space in most editors. Safe:
    // this file is UTF-8 and Harmony reads it as such (see ✓ ✕ • glyphs).
    function nb(s) { return String(s).replace(/ /g, " "); }
    var statusLbl = new QLabel(
      nb("Layer: " + layer.node) + "  •  " + nb("element #" + layer.elementId) +
      "  •  " + nb(notesPortInfo(layer.node)) + "  •  " + nb("v" + SN_VERSION));
    statusLbl.styleSheet = "color: gray; font-size: 10px;";
    statusLbl.wordWrap = true;
    // Compressible: without an explicit minimum, this label's size hint
    // forced the whole WINDOW wider (v0.19.1 regression). Now it wraps to
    // a second line on the left instead of stretching the row.
    statusLbl.minimumWidth = 1;
    addW(bottom, statusLbl, 1);
    var copyBtn = new QPushButton("Copy All");
    copyBtn.toolTip = "Copy every note as plain text — paste into any app";
    // Static label, no width pin (v0.20.1): on this engine pins only take
    // effect on the NEXT relayout, and the feedback text change was the
    // relayout trigger — natural size at launch, snap-to-pin on click =
    // the "shrink". No text change + no pin = nothing ever moves.
    var clearBtn = new QPushButton("Clear all");
    clearBtn.toolTip = "Clear notes, sub art, or everything (asks first)";
    addW(bottom, copyBtn);
    addW(bottom, clearBtn);
    addW(outer, bottomW);

    // ---- staleness state (v0.10.0) ----
    var shownSig = "";    // drawing:frame signature of what's displayed
    var drafts = {};      // unsaved input text, preserved across rebuilds
    var liveInputs = {};  // drawingName -> its QTextEdit in the current build
    var liveGroups = {};  // drawingName -> its group card in the current build
    var staleTimer = null;
    var lastSignal = "";  // which notifier signal requested the last check
    var hlGroup = null;   // currently highlighted group card
    var hlTimer = null;   // clears the highlight after a moment
    var editingNoteId = null; // note unlocked for in-place editing, or null
    var editDraft = null;     // mid-edit text captured across rebuilds
    var liveNoteBoxes = {};   // noteId -> its QTextEdit in the current build

    // Signature of the live timeline state the list depends on.
    function groupsSignature() {
      var groups = collectGroups(layer, model);
      var parts = [];
      for (var i = 0; i < groups.length; i++) {
        // first AND last: exposure-length changes must read as stale too
        parts.push(groups[i].drawing + ":" + groups[i].frame + "-" + groups[i].last);
      }
      return parts.join("|");
    }

    // Optional focusDrawing: after the rebuild, scroll to and highlight that
    // group instead of restoring the previous scroll position (used by the
    // Add Note button so the new sub is immediately visible).
    function refresh(focusDrawing) {
      // Rebuilding the list resets the scroll position — remember it so
      // adding a note deep in the list doesn't yank the view around.
      var savedScroll = 0;
      try { savedScroll = scroll.verticalScrollBar().value; } catch (e) {}

      // Capture mid-edit text — ONLY from the box that actually is the
      // editor. (The v0.21.1 failure: the stash captured from a box that
      // was not yet the editor, saving emptiness as the "draft".)
      try {
        if (editingNoteId !== null && liveNoteBoxes[editingNoteId]) {
          editDraft = String(liveNoteBoxes[editingNoteId].plainText);
        }
      } catch (e) { /* best-effort */ }
      liveNoteBoxes = {};

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
      liveGroups = {};
      hlGroup = null; // its widget is about to be torn down

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
      if (focusDrawing && liveGroups[focusDrawing]) {
        focusGroup(focusDrawing); // don't restore old scroll — go to the card
      } else {
        restoreScroll(savedScroll);
      }
      updateScrubButtons();

      // Note boxes measure against the wrong wrap width until the layout
      // computes geometry (the tiny-scrollbox bug, understood since
      // v0.21.1) — re-measure the whole batch once it has.
      try {
        var mt;
        try { mt = new QTimer(dlg); }
        catch (e0) { mt = new QTimer(); }
        g_snKeepAlive.push(mt);
        mt.singleShot = true;
        mt.timeout.connect(function () {
          try {
            for (var nid in liveNoteBoxes) {
              if (liveNoteBoxes.hasOwnProperty(nid)) {
                sizeNoteInput(liveNoteBoxes[nid]); // matters only mid-edit
              }
            }
          } catch (e) {}
        });
        mt.start(60);
      } catch (e) { /* immediate sizing already happened per card */ }
    }

    // Align a group card's top with the viewport top, so its header and
    // "Add a note…" input land right under the toolbar (a fresh sub should
    // appear next to the Add Note button, not somewhere mid-list).
    function scrollGroupToTop(drawingName) {
      var w = liveGroups[drawingName];
      if (!w) return;
      try {
        // Right after a rebuild the cards aren't measured yet and pos.y is
        // garbage — which made "scroll to new note" only work when the bar
        // already sat at the top (garbage 0 = top, correct by luck).
        // Force the layout to compute geometry before reading positions.
        try { listLayout.activate(); } catch (e9) {}
        var y = 0;
        try { y = (typeof w.pos.y === "function") ? w.pos.y() : w.pos.y; }
        catch (e0) { y = Number(w.y) || 0; }
        var sb = scroll.verticalScrollBar();
        var target = y - 6; // small breathing room above the card
        if (target < 0) target = 0;
        if (target > Number(sb.maximum)) target = Number(sb.maximum);
        sb.value = target;
      } catch (e) { /* leave the panel scroll as-is */ }
    }

    // Scroll a (usually new) group to the top and flash it — applied three
    // times (now, 60 ms, 250 ms): right after a rebuild the list may not be
    // measured yet and early scrolls can aim at stale positions, especially
    // while Harmony is busy.
    function focusGroup(drawingName) {
      scrollGroupToTop(drawingName);
      highlightGroup(drawingName);
      var delays = [60, 250];
      for (var i = 0; i < delays.length; i++) {
        try {
          var t;
          try { t = new QTimer(dlg); }
          catch (e0) { t = new QTimer(); }
          g_snKeepAlive.push(t);
          t.singleShot = true;
          t.timeout.connect(function () {
            try { scrollGroupToTop(drawingName); } catch (e) {}
          });
          t.start(delays[i]);
        } catch (e) { /* earlier attempts already did their best */ }
      }
    }

    // Gray out ◀/▶ when there's no note strictly before/after the playhead.
    // Uses the same data as the jump logic, so button state and jump
    // behavior can never disagree.
    function updateScrubButtons() {
      try {
        var f = frame.current();
        var groups = collectGroups(layer, model);
        var hasPrev = false;
        var hasNext = false;
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i].frame;
          if (g <= 0) continue;
          if (g < f) hasPrev = true;
          if (g > f) hasNext = true;
          if (hasPrev && hasNext) break;
        }
        prevBtn.enabled = hasPrev;
        nextBtn.enabled = hasNext;
      } catch (e) { /* leave buttons as-is */ }
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
      var lastNo = group.last;

      var box = new QFrame();
      box.frameShape = QFrame.StyledPanel;
      liveGroups[drawingName] = box; // for scrub-to-card panel scrolling
      var v = new QVBoxLayout(box);

      var notes = notesFor(model, layer.elementId, drawingName);

      // Header row: green clickable "Frame 42" / "Frame 42 - 43" link —
      // plain numbers with no zero-padding, matching Harmony's own
      // timeline fields (v0.26.0 user spec); the range shows first & last
      // exposed frame, clicking always jumps to the first. Plus, when the
      // group has NO notes, a remove button that deletes the sub itself.
      // Link-based navigation is deliberate: card-wide click filters felt
      // unreliable (user call, v0.8.3) — links are native QLabel behavior.
      var headRowW = new QWidget();
      var headRow = new QHBoxLayout(headRowW);
      headRow.setContentsMargins(0, 0, 0, 0);
      if (frameNo > 0) {
        var frameText = "Frame " + frameNo +
                        (lastNo > frameNo ? " - " + lastNo : "");
        var head = new QLabel(
          '<a href="#" style="' + LINK_STYLE + ' font-weight:bold;">' +
          frameText + "</a>");
        head.toolTip = "Go to Frame " + frameNo;
        head.linkActivated.connect(makeJumpToSub(drawingName, frameNo));
        addW(headRow, head, 1);
      } else {
        var deadHead = new QLabel("(not exposed on timeline)  •  Sub " + drawingName);
        deadHead.styleSheet = "color: gray;";
        addW(headRow, deadHead, 1);
      }
      if (notes.length === 0) {
        // Only noteless groups are removable — a sub carrying notes can't
        // be nuked by accident; delete its notes first.
        var rmBtn = new QPushButton("✕");
        rmBtn.toolTip = "Remove this sub (it has no notes)";
        rmBtn.maximumWidth = 28;
        rmBtn.clicked.connect(function () {
          if (removeSubstitution(layer, drawingName)) {
            try {
              var eid = String(layer.elementId);
              if (model.notesByDrawing[eid]) delete model.notesByDrawing[eid][drawingName];
            } catch (e) { /* model tidy-up is best-effort */ }
            saveModel(model);
            refresh();
          }
        });
        addW(headRow, rmBtn);
      }
      addW(v, headRowW);

      // Existing notes.
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

      // explicitText (optional): the text to save, bypassing input.plainText
      // — used by the textChanged path to save the text as it was BEFORE the
      // stray Enter newline was inserted.
      function commit(explicitText) {
        var txt = (explicitText !== undefined) ? explicitText : "";
        if (explicitText === undefined) {
          try { txt = String(input.plainText); } catch (e) {}
        }
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
      noteBtn.clicked.connect(function () { commit(); });

      // Enter handling, primary path: event filter (consumes the key).
      var filter = makeEnterFilter(function () { commit(); });
      if (filter) {
        try { input.installEventFilter(filter); } catch (e) { filter = null; }
      }

      // Enter handling, fallback path + auto-grow: if the filter is inert,
      // the Enter lands as a newline in the text. Detect a single un-shifted
      // Enter anywhere (not just the end) and commit the pre-newline text.
      var prevAddText = "";
      try { prevAddText = String(input.plainText); } catch (e) {}
      input.textChanged.connect(function () {
        sizeNoteInput(input);
        try {
          var t = String(input.plainText);
          if (isEnterKeypress(prevAddText, t)) { commit(prevAddText); return; }
          prevAddText = t;
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

      // Sub link FIRST, date second (v0.22.2): the link then sits directly
      // under the green Frame header link, stacking the two click targets
      // into one wide navigation zone at the card's left edge.
      var metaHtml = "";
      if (frameNo > 0) {
        metaHtml += '<a href="#" style="' + LINK_STYLE + ' font-size:10px;">Sub ' +
                    drawingName + "</a>";
      } else {
        metaHtml += '<span style="color:gray; font-size:10px;">Sub ' +
                    drawingName + "</span>";
      }
      metaHtml += '<span style="color:gray; font-size:10px;">   •   ' +
                  relativeDate(note) + "</span>";
      var meta = new QLabel(metaHtml);
      if (frameNo > 0) meta.linkActivated.connect(makeJumpToSub(drawingName, frameNo));
      addW(textCol, meta);

      // ---- HYBRID text system (v0.25.0-beta): each card carries BOTH a
      // real QLabel (display — pixel-identical to stable BY CONSTRUCTION,
      // nothing to impersonate) and a native QTextEdit editor, hidden
      // until ✎. Editing = a visibility flip: no rebuild, no layout
      // surgery, no styling of native widgets, no pixel tuning.
      var isEditingThis = (editingNoteId === note.id);

      var textLbl = new QLabel(renderNoteHtml(note.text)); // markers → rich
      textLbl.wordWrap = true;
      // Selectable + copyable (drag to select, Ctrl+C / right-click Copy).
      try { textLbl.textInteractionFlags = Qt.TextSelectableByMouse; }
      catch (e) { /* engine refused the flag; text stays non-selectable */ }
      dimNoteText(textLbl, note.done === true);
      addW(textCol, textLbl);

      var box = new QTextEdit(); // native = identical to the add box
      box.plainText = (isEditingThis && editDraft !== null)
        ? editDraft : String(note.text); // rebuilt mid-edit: restore draft
      sizeNoteInput(box);
      liveNoteBoxes[note.id] = box;
      addW(textCol, box);

      // Exactly one of the pair is ever visible.
      if (isEditingThis) { try { textLbl.hide(); } catch (e) {} }
      else { try { box.hide(); } catch (e) {} }

      // Pack meta + text to the TOP: when the button column is taller than
      // the text, the text column otherwise centers in the leftover space
      // (inconsistent line starts across cards — v0.25.1 fix).
      addW(textCol, new QWidget(), 1);
      addW(h, textColW, 1);

      // Flip back to the label, saving or discarding. Programmatic text
      // resets re-trigger textChanged, so state is cleared FIRST and the
      // handler ignores non-editing events.
      var finishEdit = function (saveIt, explicitText) {
        if (editingNoteId !== note.id) return;
        var txt = (explicitText !== undefined) ? explicitText : "";
        if (explicitText === undefined) {
          try { txt = String(box.plainText); } catch (e) {}
        }
        txt = txt.replace(/^\s+|\s+$/g, "");
        editingNoteId = null;
        editDraft = null;
        if (saveIt && txt !== "" && txt !== String(note.text)) {
          note.text = txt;
          saveModel(model);
          trace("edit saved (note " + note.id + ")");
        } else {
          trace("edit closed without changes (note " + note.id + ")");
        }
        try { textLbl.text = renderNoteHtml(note.text); } catch (e) {}
        try { box.plainText = String(note.text); } catch (e) {}
        try { box.hide(); } catch (e) {}
        try { textLbl.show(); } catch (e) {}
        try { editBtn.toolTip = "Edit note"; } catch (e) {}
      };

      // Same Enter machinery as the add box: Enter = save, Shift+Enter =
      // newline. The filter also fires on a focused read-only box, but
      // finishEdit no-ops unless this note is the one being edited.
      var editKeyFilter = makeEnterFilter(function () { finishEdit(true); });
      if (editKeyFilter) {
        try { box.installEventFilter(editKeyFilter); } catch (e) {}
      }
      // Position-independent Enter detection (v0.28.1): compare to the
      // previous text so a mid-line Enter saves too. prevEditText tracks
      // the box content; programmatic sets (show/finishEdit) change it by
      // more than one char, so they never look like an Enter keypress.
      var prevEditText = "";
      try { prevEditText = String(box.plainText); } catch (e) {}
      box.textChanged.connect(function () {
        if (editingNoteId !== note.id) {          // programmatic reset / locked
          try { prevEditText = String(box.plainText); } catch (e) {}
          return;
        }
        sizeNoteInput(box); // auto-grow while typing
        try {
          var t = String(box.plainText);
          if (isEnterKeypress(prevEditText, t)) {
            finishEdit(true, prevEditText); // save text as it was pre-newline
            return;
          }
          prevEditText = t;
        } catch (e) { /* typing must never break */ }
      });

      var delBtn = new QPushButton("✕");
      delBtn.toolTip = "Delete note";
      // Fixed geometry on BOTH right-column buttons: applying/removing a
      // stylesheet after show recomputes a button's size hint (the v0.14.3
      // click-resize bug) — locking min=max makes restyles size-neutral.
      delBtn.minimumWidth = 28;
      delBtn.maximumWidth = 28;
      delBtn.minimumHeight = 20; // comfortable size restored (v0.25.1): the
      delBtn.maximumHeight = 20; // hybrid's cards no longer need slim buttons
      delBtn.clicked.connect((function (nid, dn) {
        return function () {
          if (editingNoteId === nid) { editingNoteId = null; editDraft = null; }
          deleteNote(model, layer.elementId, dn, nid);
          saveModel(model);
          refresh();
        };
      })(note.id, drawingName));

      // ✎ between ✕ and ○: unlocks THIS box in place; clicking again
      // cancels. One note at a time; Esc is deliberately not a cancel key
      // (it closes the whole panel).
      var editBtn = new QPushButton("✎");
      editBtn.toolTip = isEditingThis ? "Cancel editing" : "Edit note";
      editBtn.minimumWidth = 28;
      editBtn.maximumWidth = 28;
      editBtn.minimumHeight = 20;
      editBtn.maximumHeight = 20;
      editBtn.clicked.connect(function () {
        if (editingNoteId === note.id) { finishEdit(false); return; } // cancel
        if (editingNoteId !== null) {
          trace("edit ignored — another note is being edited");
          return;
        }
        editingNoteId = note.id;
        editDraft = null;
        try { box.plainText = String(note.text); } catch (e) {}
        try { textLbl.hide(); } catch (e) {}
        try { box.show(); } catch (e) {}
        sizeNoteInput(box); // measured while shown: layout width is real
        try { box.setFocus(); }
        catch (e0) { try { box.setFocus(7); } catch (e1) {} } // 7 = OtherFocusReason
        try { editBtn.toolTip = "Cancel editing"; } catch (e) {}
        trace("editing note " + note.id + " in place");
      });

      // Done toggle, right under the ✕ — a NATIVE button just like it, so
      // shape, size, and hover thickness match by construction (custom
      // stylesheets are what caused the v0.14.2 misalignment/hover
      // mismatch). ○ = open, green ✓ = done. Toggling restyles in place —
      // deliberately NO refresh(), so scroll/drafts/focus are untouched;
      // rebuilds re-read note.done from the model.
      var doneBtn = new QPushButton("");
      doneBtn.minimumWidth = 28; // identical fixed geometry to the ✕ above
      doneBtn.maximumWidth = 28;
      doneBtn.minimumHeight = 20;
      doneBtn.maximumHeight = 20;
      styleDoneToggle(doneBtn, note.done === true);
      doneBtn.clicked.connect(function () {
        note.done = (note.done !== true); // missing field counts as unchecked
        saveModel(model);
        styleDoneToggle(doneBtn, note.done);
        dimNoteText(textLbl, note.done); // done notes read as "handled"
      });

      // ✕ / ✎ / ○ stacked vertically at 28×20 each; spacer pins them top.
      var rightColW = new QWidget();
      var rightCol = new QVBoxLayout(rightColW);
      rightCol.setContentsMargins(0, 0, 0, 0);
      rightCol.setSpacing(4);
      addW(rightCol, delBtn);
      addW(rightCol, editBtn);
      addW(rightCol, doneBtn);
      addW(rightCol, new QWidget(), 1);
      addW(h, rightColW);

      return card;
    }

    // Jump by DRAWING, not by a frame captured at build time: the sub's
    // first frame is recomputed at click time, so a sub moved on the
    // timeline still navigates correctly — and if the recomputed frame
    // disagrees with what the card shows, the display heals itself.
    function makeJumpToSub(dn, shownFrame) {
      return function () {
        var f = firstFrameOfDrawing(layer.column, dn);
        if (f > 0) {
          frame.setCurrent(f);
          scrollTimelineToFrame(f); // bring the sub into the Timeline view
        }
        if (f !== shownFrame) refresh(); // display was stale (also updates ◀/▶)
        else updateScrubButtons();
      };
    }

    // Flash a white border on the card the arrow keys landed on, so it's
    // obvious where navigation went; fades automatically. Deliberately
    // styling-only (no event filters — see the v0.8.x card-click saga);
    // the #id selector keeps the border off the note cards inside.
    function highlightGroup(drawingName) {
      clearHighlight();
      var w = liveGroups[drawingName];
      if (!w) return;
      try {
        w.objectName = "snGroupHL";
        w.styleSheet = "#snGroupHL { border: 1px solid #ffffff; border-radius: 3px; }";
        hlGroup = w;
      } catch (e) { return; } // styling refused; nothing to clean up
      try {
        if (!hlTimer) {
          try { hlTimer = new QTimer(dlg); }
          catch (e0) { hlTimer = new QTimer(); }
          hlTimer.singleShot = true;
          hlTimer.timeout.connect(clearHighlight);
          g_snKeepAlivePanel.push(hlTimer); // survives refreshes
        }
        hlTimer.stop();
        hlTimer.start(2500);
      } catch (e) { /* highlight just stays until the next one */ }
    }

    function clearHighlight() {
      try { if (hlGroup) hlGroup.styleSheet = ""; } catch (e) {}
      hlGroup = null;
    }

    // Done-toggle styling: a NATIVE button (no border/shape stylesheets),
    // so it renders, hovers, and presses exactly like the ✕ next to it.
    // State is the glyph: ○ = open, bold green ✓ = done. The checked state
    // sets only a text color — if that turns out to suppress the native
    // hover on some engine, removing that one line is the fallback.
    function styleDoneToggle(btn, done) {
      try {
        if (done) {
          btn.text = "✓";
          btn.toolTip = "Done — click to reopen";
          // Scoped to QPushButton: an unscoped stylesheet cascades into the
          // TOOLTIP too, rendering its text green-on-yellow (unreadable).
          btn.styleSheet = "QPushButton { color: " + SN_GREEN + "; font-weight: bold; }";
        } else {
          btn.text = "○";
          btn.toolTip = "Mark as done";
          btn.styleSheet = "";
        }
      } catch (e) {
        // Styling refused by the engine: degrade to a plain text toggle.
        try { btn.text = done ? "✓" : "○"; } catch (e2) {}
      }
    }

    // Done notes read grayed-out — signals "handled, no need to re-read".
    // (The hybrid design retired styleNoteBox: display is a real QLabel,
    // the editor is a fully native QTextEdit — nothing to impersonate.)
    // BETA (markers): render **bold** / *italic* in the DISPLAY label only.
    // Storage stays plain text — old notes untouched, the editor shows raw
    // markers, Copy All is unchanged (Slack renders the markers natively).
    // Escape first so literal < > & in notes can't inject markup; newlines
    // become <br> (rich mode ignores \n); the <span> wrapper forces QLabel
    // onto the rich-text path even when a note has entities but no tags
    // (otherwise "&amp;" would display literally).
    function renderNoteHtml(text) {
      var s = String(text);
      s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"); // ** before * on purpose
      s = s.replace(/\*([^*]+)\*/g, "<i>$1</i>");
      s = s.replace(/\n/g, "<br>");
      return "<span>" + s + "</span>";
    }

    function dimNoteText(lbl, done) {
      try { lbl.styleSheet = done ? "color: #808080;" : ""; } catch (e) {}
    }

    // Multiline note box sizing: wrap + grow with content (cap, then scroll).
    // Falls back to a fixed 2-line height if document metrics aren't bound.
    // Optional minH: the ADD box keeps the 44px two-line floor; locked
    // note DISPLAY boxes pass 24 so one-liners don't carry empty slack
    // (v0.24.4 — the "extra padding" was mostly this inherited floor).
    function sizeNoteInput(edit, minH) {
      var floorH = (minH === undefined) ? 44 : minH;
      var h = floorH;
      try {
        var doc = null;
        try { doc = edit.document(); } catch (e0) { doc = edit.document; }
        var s = doc.size;
        var dh = (typeof s.height === "function") ? s.height() : s.height;
        if (dh && dh > 0) h = Math.ceil(dh) + 12;
      } catch (e) { /* keep fallback height */ }
      if (h < floorH) h = floorH;
      if (h > 160) h = 160; // ~8 lines, then the box scrolls internally
      edit.minimumHeight = h;
      edit.maximumHeight = h;
    }

    // Event filter so Enter submits and Shift+Enter inserts a newline.
    // Returns null if this engine can't build QObject-based filters — the
    // textChanged fallback in makeGroupWidget covers that case.
    // True when the change from `prev` to `now` is a single un-shifted
    // Enter keypress inserted ANYWHERE — not just at the end. The old
    // trailing-"\n" check only caught Enter at the end of the text, so
    // editing a note mid-line and pressing Enter inserted a newline
    // instead of saving (v0.28.1). A lone Enter adds exactly one char
    // (\n); pastes and normal typing don't match and fall through to a
    // real newline. Reading modifiers at textChanged time is reliable in
    // this build (the add box has relied on it since v0.24).
    function countNewlines(s) {
      var n = 0;
      for (var i = 0; i < s.length; i++) if (s.charAt(i) === "\n") n++;
      return n;
    }
    function isEnterKeypress(prev, now) {
      if (now.length !== prev.length + 1) return false;
      if (countNewlines(now) !== countNewlines(prev) + 1) return false;
      try {
        if (QApplication.keyboardModifiers() & Qt.ShiftModifier) return false;
      } catch (e) { /* can't read shift → treat as Enter-save */ }
      return true;
    }

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
      if (drawingName) refresh(drawingName); // scroll to + flash the new group
    });

    // Scrub the playhead between note frames, anchored to wherever the
    // playhead currently is (frames recomputed live so new subs count).
    function scrubToNoteFrame(dir) {
      var f = frame.current();
      var groups = collectGroups(layer, model);
      var best = -1;
      var bestDrawing = "";
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i].frame;
        if (g <= 0) continue;
        if (dir > 0 && g > f && (best < 0 || g < best)) { best = g; bestDrawing = groups[i].drawing; }
        if (dir < 0 && g < f && (best < 0 || g > best)) { best = g; bestDrawing = groups[i].drawing; }
      }
      if (best > 0) { // no next/prev note: do nothing
        frame.setCurrent(best);
        scrollTimelineToFrame(best);     // Timeline follows the jump
        scrollGroupToTop(bestDrawing);   // panel: card pinned under toolbar
        highlightGroup(bestDrawing);     // ...and flashed so you see it land
        updateScrubButtons();            // instant gray-out at the ends
      }
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
              if (editingNoteId !== null) {
                // Never rebuild under someone's cursor mid-edit; check
                // again shortly — it catches up after save/cancel.
                trace("auto-refresh deferred (a note is being edited)");
                scheduleStalenessCheck();
                return;
              }
              if (groupsSignature() !== shownSig) {
                trace("timeline changed under the panel (via " + lastSignal +
                      ") — auto-refreshing");
                refresh(); // refresh() updates the scrub buttons too
              } else {
                updateScrubButtons(); // playhead may have moved past the ends
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

    // ---- Copy All (v0.19.0): notes as plain text for any app ----
    function buildDigest() {
      var lines = [];
      var now = new Date();
      lines.push("SyncNote — " + scene.currentScene() + " (" +
                 now.getFullYear() + "-" + pad(now.getMonth() + 1, 2) + "-" +
                 pad(now.getDate(), 2) + ")");
      var groups = collectGroups(layer, model);
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var notes = notesFor(model, layer.elementId, g.drawing);
        if (notes.length === 0) continue;
        lines.push("");
        lines.push((g.frame > 0
                     ? "Frame " + g.frame + (g.last > g.frame ? " - " + g.last : "")
                     : "(not exposed)") +
                   "  (Sub " + g.drawing + ")");
        for (var j = 0; j < notes.length; j++) {
          var mark = (notes[j].done === true) ? "[x]" : "[ ]";
          var txt = String(notes[j].text).split("\n");
          lines.push("  " + mark + " " + txt[0]);
          for (var k = 1; k < txt.length; k++) lines.push("      " + txt[k]);
        }
      }
      return lines.join("\n");
    }

    // Guaranteed path if the clipboard binding is refused: show the digest
    // in a selectable box for a manual Ctrl+C.
    function showDigestFallback(digest) {
      var d = new QDialog(dlg);
      d.setWindowTitle("SyncNote — Copy Notes");
      d.minimumWidth = 380;
      d.minimumHeight = 300;
      var v = new QVBoxLayout(d);
      var hint = new QLabel("Clipboard unavailable on this engine — select " +
                            "the text below and press Ctrl+C:");
      hint.wordWrap = true;
      addW(v, hint);
      var box = new QTextEdit();
      box.plainText = digest;
      try { box.readOnly = true; } catch (e) { /* still selectable */ }
      addW(v, box, 1);
      var closeBtn = new QPushButton("Close");
      closeBtn.clicked.connect(function () { d.accept(); });
      addW(v, closeBtn);
      d.exec();
    }

    // No button-text feedback (v0.20.1, user decision): every variant of
    // swapping the label caused size glitches on this engine. The button
    // is fully static; success is confirmed by the Message Log trace (and
    // by the paste working). The fallback dialog still covers clipboard
    // failure visibly.
    copyBtn.clicked.connect(function () {
      var digest = buildDigest();
      var ok = false;
      try {
        QApplication.clipboard().setText(digest);
        ok = true;
      } catch (e) {
        trace("clipboard unavailable (" + e + ") — showing manual-copy dialog");
      }
      if (!ok) { showDigestFallback(digest); return; }
      trace("notes digest copied to clipboard (" + digest.length + " chars)");
    });

    // ---- Clear all (v0.19.0): confirmation with a keyboard default ----
    // Own QDialog instead of MessageBox: we need four choices, a reliable
    // Enter default, and known return semantics. Subs are NEVER deleted
    // here — notes and/or the art inside the subs, per user decision.
    function askClearChoice() {
      var d = new QDialog(dlg);
      d.setWindowTitle("Clear SyncNote data");
      d.minimumWidth = 380;
      var v = new QVBoxLayout(d);
      var lbl = new QLabel(
        "Clear SyncNote data from this scene?\n" +
        "Notes Only / Sub Art Only keep the subs on the timeline.\n" +
        "Clear Both removes everything and closes the panel. One undo step.");
      lbl.wordWrap = true;
      addW(v, lbl);

      var rowW = new QWidget();
      var row = new QHBoxLayout(rowW);
      row.setContentsMargins(0, 0, 0, 0);
      var choice = "";
      function mkChoice(label, value, isDefault) {
        var b = new QPushButton(label);
        try { b.setProperty("default", isDefault); } catch (e0) {}
        try { b.setProperty("autoDefault", isDefault); } catch (e1) {}
        b.clicked.connect(function () { choice = value; d.accept(); });
        addW(row, b);
      }
      mkChoice("Clear Both", "both", true); // Enter fires this one
      mkChoice("Notes Only", "notes", false);
      mkChoice("Sub Art Only", "art", false);
      var cancelBtn = new QPushButton("Cancel");
      try { cancelBtn.setProperty("autoDefault", false); } catch (e2) {}
      cancelBtn.clicked.connect(function () { d.reject(); }); // Esc also rejects
      addW(row, cancelBtn);
      addW(v, rowW);

      d.exec();
      return choice; // "" = cancelled
    }

    function doClear(mode) {
      scene.beginUndoRedoAccum("SyncNote: clear " + mode);
      try {
        if (mode === "notes" || mode === "both") {
          model.notesByDrawing[String(layer.elementId)] = {};
          saveModel(model);
        }
        if (mode === "art" || mode === "both") {
          clearAllSubArt(layer);
        }
        if (mode === "both") {
          clearAllExposure(layer); // full reset: subs leave the timeline too
        }
        scene.endUndoRedoAccum();
      } catch (e) {
        scene.endUndoRedoAccum();
      }
      trace("clear (" + mode + ") done — one undo step");
      if (mode === "both") {
        // Full reset ends the review session: close the panel (which also
        // routes through save-on-close, landing the reset on disk).
        dlg.close();
      } else {
        refresh();
      }
    }

    clearBtn.clicked.connect(function () {
      var mode = askClearChoice();
      if (mode) doClear(mode);
    });

    // ---- save-on-close (v0.16.0, user decision: option A) ----
    // Closing the panel saves the scene so notes reach disk without anyone
    // remembering Ctrl+S — but only when it's actually needed:
    //   - notes changed this session (g_snNotesDirty), AND
    //   - the scene still has unsaved changes (a manual Ctrl+S clears both).
    // Relaunch-closes are marked snSilentClose and skipped. At most one
    // save per session-close — no xstage churn.
    // NOTE: saveAll() commits the WHOLE scene, not just notes. If teachers
    // prefer confirming, the prompt variant is documented in the KB (§25).
    dlg.rejected.connect(function () {
      try {
        try { if (dlg.property("snSilentClose")) return; } catch (e0) {}
        if (!g_snNotesDirty) return; // nothing of ours to persist
        var dirty = true;
        try { dirty = scene.isDirty(); } catch (e1) {}
        if (!dirty) { g_snNotesDirty = false; return; } // already saved manually
        var ok = false;
        try { ok = scene.saveAll(); } catch (e2) {}
        if (ok) g_snNotesDirty = false;
        trace(ok ? "panel closed — scene saved (notes persisted)"
                 : "panel closed — auto-save FAILED; save manually to keep notes");
      } catch (e) { /* closing must never be blocked */ }
    });

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
