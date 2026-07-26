/*
 * SyncNoteBeta.js  —  AUTO MODE BETA (toolbar function: SyncNoteBeta)
 * Adds a Manual/Auto mode toggle: in Auto, clicking empty space in the
 * list starts a note at the playhead (no Add Note button needed), and an
 * abandoned empty prompt cleans itself up. Fold into SyncNote.js on
 * approval; safe to run beside the stable build.
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
 *   - Clicking anywhere on a note card — its text, its background, or the
 *     green "Frame ####" link — jumps the playhead there, so you see the
 *     note and the artwork together (card-wide since v0.32.0).
 *
 * Compatibility: Harmony 22 and 24/25 Premium (Qt Script / ECMAScript).
 *
 * Install: copy to your user scripts folder. When binding a toolbar button,
 *   there is exactly ONE function to pick: SyncNoteBeta. All helpers are
 *   nested inside it so they don't clutter the function picker.
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

function SyncNoteBeta() {
  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------
  var SN_VERSION    = "0.34.0-beta.11";  // AUTO MODE v2 BETA (2026-07-26)
  // Teachers' update channel: the GitHub release branch (public repo).
  // main = development; release only receives Zack-blessed versions.
  var SN_UPDATE_URL = "https://raw.githubusercontent.com/makermatic/SyncNote/release/SyncNote.js";
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

  // ---- mode policy (v0.34.0): change ONE line to change the default ----
  // The panel opens in SN_DEFAULT_MODE every launch. Flip the REMEMBER
  // switch to true and the last-used mode rides in the scene's metadata
  // instead (survives restarts because the SCENE remembers — Harmony's
  // own preferences storage is unreliable across restarts, KB §36).
  // THREE modes (user design, 2026-07-26): "manual" = classic buttons;
  // "hybrid" = v1 Auto (a click on any non-interactive spot creates the
  // note prompt at the playhead); "auto" = v2 (the prompt FOLLOWS the
  // playhead — virtual card, no sub until the note commits).
  var SN_DEFAULT_MODE = "manual";           // "manual" | "hybrid" | "auto"
  var SN_REMEMBER_MODE_IN_SCENE = false;    // true = per-scene stickiness
  // Auto focus policy: "steal" moves the keyboard into the prompt box
  // when the playhead settles (an EMPTY box passes < > , . and arrow keys
  // through as real frame steps, so keyboard scrubbing survives the
  // steal); "off" = prompt follows visibly, a click on the panel focuses.
  var SN_AUTO_FOCUS = "steal";              // "steal" | "off"

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
    // The launch info line (beta.8, user design): the Layer/element/port
    // readout that used to clutter the bottom strip now leads the log.
    // (The version is already in every line's prefix.)
    trace("Layer: " + layer.node + "  •  element #" + layer.elementId +
          "  •  " + notesPortInfo(layer.node));
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

  // One pass over the whole Notes column: per drawing, a LIST of contiguous
  // exposure SPANS [{first,last},…] (v0.33.0). The old single {first,last}
  // pair was blind to gaps: a sub re-exposed later collapsed into one fake
  // range ("Frame 69 - 87" for 69-73 + 87) or a two-single-frame sub read
  // as continuous ("Frame 90 - 100" for 90 + 100). A gap — any frame not
  // showing the drawing — now starts a new span, feeding the "Frame 69 -
  // 73 & 87" headers, the scrub stops, and the staleness signature (so
  // re-exposure drags auto-refresh the panel too).
  function exposureMap(colName) {
    var map = {};
    var n = frame.numberOf();
    for (var f = 1; f <= n; f++) {
      var d = "";
      try { d = column.getEntry(colName, 1, f); } catch (e) { continue; }
      if (!d || d === "") continue;
      var spans = map[d];
      if (!spans) { map[d] = [{ first: f, last: f }]; continue; }
      var cur = spans[spans.length - 1];
      if (f === cur.last + 1) cur.last = f;   // still contiguous: extend
      else spans.push({ first: f, last: f }); // gap: a new span begins
    }
    return map;
  }

  // Render a span list for headers / Copy All: "42", "42 - 43",
  // "69 - 73 & 87", "90 & 100" — no zero-padding, single frames as bare
  // numbers, spans joined with " & " (v0.33.0 user spec).
  function spanText(spans) {
    var parts = [];
    for (var i = 0; i < (spans ? spans.length : 0); i++) {
      parts.push(spans[i].first === spans[i].last
        ? String(spans[i].first)
        : spans[i].first + " - " + spans[i].last);
    }
    return parts.join(" & ");
  }

  // Every drawing in the element, plus any drawing that has notes, each
  // with its exposure spans and first exposed frame (-1 if not exposed).
  // `frame` (the first span's start) stays the sort key and jump target.
  function collectGroups(layer, model) {
    var seen = {};
    var groups = [];
    var exp = exposureMap(layer.column);

    var timings = column.getDrawingTimings(layer.column) || [];
    for (var i = 0; i < timings.length; i++) {
      var dn = timings[i];
      if (seen[dn]) continue;
      seen[dn] = true;
      var s1 = exp[dn];
      // A drawing with no exposure AND no notes carries no information —
      // hide it instead of cluttering the list with "(not exposed)" cards.
      if (!s1 && notesFor(model, layer.elementId, dn).length === 0) continue;
      groups.push({ drawing: dn, frame: s1 ? s1[0].first : -1, spans: s1 || [] });
    }

    var byEl = model.notesByDrawing[String(layer.elementId)] || {};
    for (var key in byEl) {
      if (!byEl.hasOwnProperty(key) || seen[key]) continue;
      if (!byEl[key] || byEl[key].length === 0) continue; // no actual notes
      seen[key] = true;
      var s2 = exp[key];
      groups.push({ drawing: key, frame: s2 ? s2[0].first : -1, spans: s2 || [] });
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
    // NOTE: no custom window icon — dlg.setWindowIcon is UNBOUND in
    // Harmony's Qt Script (live TypeError, 2026-07-10). Case closed after
    // three attempts; full history in KB §34. Don't reopen unless a future
    // Harmony binds the call.

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
    // ---- mode toggle (v0.34.0): Manual = today's behavior; Auto = a
    // click on empty list space starts a note at the playhead. A clickable
    // LABEL, deliberately not a button: label text swaps are safe on this
    // engine, button label swaps glitch (KB §7.3.5).
    var snMode = initialMode();
    var modeLbl = new QLabel("");
    modeLbl.toolTip = "Click to cycle modes.\n" +
                      "Manual: only the Add Note button creates notes.\n" +
                      "Hybrid: clicking empty panel space starts a note at " +
                      "the playhead.\n" +
                      "Auto: the note prompt follows the playhead — change " +
                      "frames and type.";
    // Toggling fires from the hover filter's release (whole label = click
    // target) with linkActivated kept as a fallback path — deduped, so
    // engines where both fire still toggle exactly once.
    var lastModeToggleMs = 0;
    function toggleMode() {
      var n = (new Date()).getTime();
      if (n - lastModeToggleMs < 200) return;
      lastModeToggleMs = n;
      setMode(snMode === "manual" ? "hybrid"
            : snMode === "hybrid" ? "auto" : "manual");
    }
    modeLbl.linkActivated.connect(toggleMode);
    updateModeLabel();
    addW(bottom, modeLbl);

    function initialMode() {
      try {
        if (SN_REMEMBER_MODE_IN_SCENE &&
            (model.lastMode === "auto" || model.lastMode === "hybrid" ||
             model.lastMode === "manual")) {
          return model.lastMode;
        }
      } catch (e) {}
      return SN_DEFAULT_MODE;
    }

    function setMode(m) {
      var prev = snMode;
      snMode = m;
      if (SN_REMEMBER_MODE_IN_SCENE) {
        try { model.lastMode = m; saveModel(model); } catch (e) {}
      }
      updateModeLabel();
      trace("mode switched to " + m);
      // Mode-transition housekeeping: leaving Hybrid abandons an empty
      // click-prompt; entering Auto spawns the follow-prompt; leaving
      // Auto removes the virtual card.
      try {
        if (prev === "hybrid") cleanupPendingAuto();
        if (m === "auto") {
          syncPromptFrame();
          refresh();
          focusPrompt();
        } else if (prev === "auto") {
          promptFrame = -1;
          refresh();
        }
      } catch (e) {}
    }

    // Mode-link color is a tiny STATE MACHINE (beta.9 user spec): white
    // exactly while hovered-and-not-pressed; green at rest AND while the
    // button is held. State-driven render, so mode flips can't lose the
    // hover state. Label text swaps are the SAFE kind (KB §7.3.5).
    var modeHovered = false;
    var modePressed = false;
    function updateModeLabel() {
      try {
        var white = modeHovered && !modePressed;
        modeLbl.text =
          '<span style="color: gray; font-size: 10px;">Mode: </span>' +
          '<a href="#" style="color: ' + (white ? "#ffffff" : SN_GREEN) +
          '; text-decoration:none; font-size: 10px;">' +
          (snMode === "auto" ? "Auto"
            : snMode === "hybrid" ? "Hybrid" : "Manual") + '</a>';
      } catch (e) {}
    }

    // Hover/press watcher: Enter/Leave/Press/Release via the proven
    // filter machinery (not the unproven linkHovered signal). The
    // release also TOGGLES — the whole label is the click target, and
    // re-rendering the link's HTML on press could make linkActivated
    // unreliable, so we don't depend on it. Never consumes; pinned.
    try {
      var hovF = new QObject(dlg);
      hovF.eventFilter = function (watched, event) {
        try {
          var t = Number(event.type());
          var ent = 10, lea = 11, prs = 2, rel = 3;
          try { ent = Number(QEvent.Enter) || 10; } catch (e0) {}
          try { lea = Number(QEvent.Leave) || 11; } catch (e1) {}
          try { prs = Number(QEvent.MouseButtonPress) || 2; } catch (e2) {}
          try { rel = Number(QEvent.MouseButtonRelease) || 3; } catch (e3) {}
          if (t === ent) { modeHovered = true; updateModeLabel(); }
          else if (t === lea) {
            modeHovered = false; modePressed = false; updateModeLabel();
          } else if (t === prs) {
            modePressed = true; updateModeLabel();
          } else if (t === rel) {
            modePressed = false; updateModeLabel();
            var isLeft = true;
            try {
              var left = 1;
              try { left = Number(Qt.LeftButton) || 1; } catch (e4) {}
              isLeft = (Number(event.button()) === left);
            } catch (e5) { /* unreadable: assume left */ }
            if (isLeft && modeHovered) toggleMode();
          }
        } catch (e) {}
        return false;
      };
      modeLbl.installEventFilter(hovF);
      g_snKeepAlivePanel.push(hovF);
    } catch (e) { /* linkActivated fallback still toggles */ }

    // Bottom strip, decluttered (beta.7, user design): the Layer/element/
    // port debug readout lives behind the ⓘ button now; the strip keeps
    // only Mode + version + buttons. The stretch spacer soaks up the gap
    // — and, being click-transparent, stays part of the Auto add-surface.
    var stretchW = new QWidget();
    addW(bottom, stretchW, 1);
    var verLbl = new QLabel(nb("v" + SN_VERSION));
    verLbl.styleSheet = "color: gray; font-size: 10px;";
    try { verLbl.textInteractionFlags = Qt.NoTextInteraction; } // click-through
    catch (e) { try { verLbl.textInteractionFlags = 0; } catch (e2) {} }
    addW(bottom, verLbl);
    // (beta.8: the ⓘ popup is gone — it crowded Copy All / Clear all and
    // risked misclicks. The same info now leads the Message Log at launch.)
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
    var clickJumpArmed = 0;   // click-jump filters armed this refresh
    var lastJumpMs = 0;       // one jump per click — a click bubbles
                              // through nested cards, so card+group filters
                              // can both see the same release event
    var autoPending = null;   // HYBRID: {drawing, frame} click-created
                              // prompt that hasn't received text yet
    var lastAutoMs = 0;       // prompt-focus/add dedupe (clicks bubble)
    var promptFrame = -1;     // AUTO: frame the VIRTUAL prompt card is
                              // rendered at — no sub exists until commit
    var promptTargetDrawing = null; // a sub already starts at promptFrame:
                                    // its own add box is the prompt
    var virtualDraft = null;  // prompt text preserved across rebuilds
    var liveVirtualInput = null; // the prompt card's box, per build
    var liveVirtualCard = null;  // ...and the card itself (scroll/flash)
    var lastKeyScrubMs = 0;   // last frame step via the prompt box's scrub
                              // keys — rebuilds are DEFERRED while this is
                              // fresh (key autorepeat's ~500 ms warm-up
                              // outlives the 300 ms debounce; a rebuild
                              // mid-hold destroys the focused box and
                              // kills the scrub)

    // Signature of the live timeline state the list depends on.
    function groupsSignature() {
      var groups = collectGroups(layer, model);
      var parts = [];
      for (var i = 0; i < groups.length; i++) {
        // ALL spans: length changes AND re-exposure drags must read stale
        parts.push(groups[i].drawing + ":" + spanText(groups[i].spans));
      }
      return parts.join("|");
    }

    // Optional focusDrawing: after the rebuild, scroll to and highlight that
    // group instead of restoring the previous scroll position (used by the
    // Add Note button so the new sub is immediately visible).
    function refresh(focusDrawing) {
      var refT0 = (new Date()).getTime(); // beta.9: measure the rebuild —
      // adds feel slower as notes grow, and this number tells us how much
      // of that is the full-list rebuild before we optimize anything.
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

      // Stash the virtual prompt's half-typed text too (Auto mode).
      try {
        if (liveVirtualInput) {
          var vtxt = String(liveVirtualInput.plainText);
          if (vtxt.replace(/^\s+|\s+$/g, "") !== "") virtualDraft = vtxt;
        }
      } catch (e) { /* best-effort */ }
      liveVirtualInput = null;
      liveVirtualCard = null;

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

      clickJumpArmed = 0; // recounted as the cards below arm their filters
      var groups = collectGroups(layer, model);
      // AUTO: does the prompt frame need a VIRTUAL card, or does a sub
      // already START there (then that group's add box IS the prompt)?
      var needVirtual = false;
      promptTargetDrawing = null;
      if (snMode === "auto" && promptFrame > 0) {
        needVirtual = true;
        for (var pi = 0; pi < groups.length && needVirtual; pi++) {
          var pspans = groups[pi].spans || [];
          for (var ps = 0; ps < pspans.length; ps++) {
            if (pspans[ps].first === promptFrame) {
              needVirtual = false;
              promptTargetDrawing = groups[pi].drawing;
              break;
            }
          }
        }
      }
      var virtualPlaced = !needVirtual;
      for (var i = 0; i < groups.length; i++) {
        if (!virtualPlaced &&
            (groups[i].frame < 0 || groups[i].frame > promptFrame)) {
          addW(listLayout, makeVirtualCard(promptFrame)); // frame order
          virtualPlaced = true;
        }
        addW(listLayout, makeGroupWidget(groups[i]));
      }
      if (!virtualPlaced) addW(listLayout, makeVirtualCard(promptFrame));
      if (clickJumpArmed > 0) {
        trace("click-jump: " + clickJumpArmed + " filter(s) armed");
      }
      if (groups.length === 0 && !liveVirtualCard) {
        var hint = new QLabel("No notes yet.\nMove the playhead and click “Add Note”.");
        hint.wordWrap = true;
        try { hint.textInteractionFlags = Qt.NoTextInteraction; } // click-through
        catch (e) { try { hint.textInteractionFlags = 0; } catch (e2) {} }
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
      try {
        var noteCount = 0;
        for (var gi = 0; gi < groups.length; gi++) {
          noteCount += notesFor(model, layer.elementId, groups[gi].drawing).length;
        }
        trace("refresh: " + groups.length + " group(s), " + noteCount +
              " note(s) rebuilt in " + ((new Date()).getTime() - refT0) + " ms");
      } catch (e) { /* diagnostics only */ }

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
          // NOTE (v0.28.6, padding saga RETIRED): rich-text QLabels
          // under-report their wrapped height ~3-4px per line (proven:
          // lblH=80 for ~100px of painted text), so long notes eat into
          // the 24px bottom margin. Unfixable on this engine: the only
          // trustworthy ruler needs QTextDocument.textWidth, whose setter
          // is silently unbound (readback proved twOK=false), so no
          // width-constrained measurement exists — label- and card-level
          // corrections are equally uncomputable. Full post-mortem: KB §33.
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
          // EVERY span start is a scrub stop (v0.33.0), matching
          // scrubToNoteFrame — the two must never disagree.
          var spans = groups[i].spans || [];
          for (var s = 0; s < spans.length; s++) {
            var g = spans[s].first;
            if (g <= 0) continue;
            if (g < f) hasPrev = true;
            if (g > f) hasNext = true;
          }
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

      var box = new QFrame();
      box.frameShape = QFrame.StyledPanel;
      liveGroups[drawingName] = box; // for scrub-to-card panel scrolling
      var v = new QVBoxLayout(box);

      var notes = notesFor(model, layer.elementId, drawingName);

      // Header row: green clickable "Frame 42" / "Frame 42 - 43" /
      // "Frame 69 - 73 & 87" link — plain numbers with no zero-padding,
      // matching Harmony's own timeline fields (v0.26.0 user spec); every
      // contiguous exposure span is listed (v0.33.0), clicking always
      // jumps to the first. Plus, when the group has NO notes, a remove
      // button that deletes the sub itself.
      // Links stay as-is; v0.32.0 also revived card-wide click-to-jump
      // (v0.8.x; the old flakiness was the GC bug, fixed by pinning) —
      // see armClickJump near makeEnterFilter.
      var headRowW = new QWidget();
      var headRow = new QHBoxLayout(headRowW);
      headRow.setContentsMargins(0, 0, 0, 0);
      if (frameNo > 0) {
        var frameText = "Frame " + spanText(group.spans);
        var head = new QLabel(
          '<a href="#" style="' + LINK_STYLE + ' font-weight:bold;">' +
          frameText + "</a>");
        head.toolTip = "Go to Frame " + frameNo;
        head.linkActivated.connect(makeJumpToSub(drawingName, frameNo));
        addW(headRow, head, 1);
      } else {
        var deadHead = new QLabel("(not exposed on timeline)  •  Sub " + drawingName);
        deadHead.styleSheet = "color: gray;";
        try { deadHead.textInteractionFlags = Qt.NoTextInteraction; } // click-through
        catch (e) { try { deadHead.textInteractionFlags = 0; } catch (e2) {} }
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
      // Plain text only (v0.29.1): rich pastes (formatted text, images —
      // one memorably included an entire YouTube card) otherwise render
      // inside the box. Notes were always SAVED plain; now the box shows
      // what will actually be kept.
      try { input.acceptRichText = false; } catch (e) {}
      // Minimal placeholder (v0.31.2): the Enter/Shift+Enter tutorial has
      // done its job — everyone knows the keys now, and the long hint
      // bloated every group card.
      try { input.placeholderText = "Add note…"; }
      catch (e) { /* placeholder not bound in some engines; cosmetic */ }
      // Dim the placeholder (SyncSketch-style: a hint shouldn't compete
      // with real notes). Placeholder color lives in a PALETTE slot, not
      // stylesheets — programmatic set, unproven binding, fully guarded:
      // worst case the placeholder keeps its default brightness.
      try {
        var pal = input.palette;
        var dim = new QColor(110, 110, 110);
        try { pal.setColor(QPalette.PlaceholderText, dim); }
        catch (e0) { pal.setColor(20, dim); } // 20 = PlaceholderText role id
        input.palette = pal;
      } catch (e) { trace("placeholder dim not supported (" + e + ")"); }
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
      // — the textChanged path passes the text as it was BEFORE the Enter's
      // newline was inserted, so the stray line break never persists.
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
      // Enter ANYWHERE (v0.28.2 — not just at the end) and commit the
      // pre-newline text.
      var prevAddText = "";
      try { prevAddText = String(input.plainText); } catch (e) {}
      input.textChanged.connect(function () {
        sizeNoteInput(input);
        try {
          var t = String(input.plainText);
          if (isEnterKeypress(prevAddText, t)) {
            trace("Enter via fallback (add box) — saving");
            commit(prevAddText);
            return;
          }
          if (looksLikeEnter(prevAddText, t)) {
            trace("newline kept (add box) — shift detected"); // diagnostics
          }
          prevAddText = t;
        } catch (e) { /* typing must never break */ }
      });

      // ---- click-to-jump (v0.32.0): the group card's background jumps too.
      // The add box, buttons, and links consume their own clicks (Qt
      // propagation), so they're exempt by construction.
      if (frameNo > 0) {
        armClickJump(box, drawingName, frameNo, null, null);
        // The header label stretches across the whole top strip and (as a
        // link-bearing QLabel) consumes clicks even BESIDE the link text —
        // they never bubble to the card filter. Arm it directly; a click
        // right on the link double-fires harmlessly (same jump target).
        armClickJump(head, drawingName, frameNo, null, null);
        try { box.cursor = new QCursor(Qt.PointingHandCursor); } catch (e) {}
        setArrowCursor(noteBtn);
        if (notes.length === 0) setArrowCursor(rmBtn);
      }

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
      // Fixed 24px bottom margin (v0.28.3): short notes get a pleasant gap
      // below the text only as LEFTOVER space (the button column props the
      // card open); long notes fill their card and looked crammed. 24px ≈
      // that leftover, made structural for every line count. (12px was
      // tried in v0.27.1 and read too small; 24 was built in v0.27.3 but
      // never tested before the rollback — this is that test.)
      textCol.setContentsMargins(0, 0, 0, 24);

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
      try { box.acceptRichText = false; } catch (e) {} // plain pastes only (v0.29.1)
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
      // Position-independent Enter detection (v0.28.2): compare with the
      // previous text so a mid-line Enter saves too — the cursor is almost
      // never at the END while editing, which is why the old trailing-"\n"
      // check made Enter act like Shift+Enter here. prevEditText tracks
      // content; programmatic sets (✎ prefill / finishEdit reset) change
      // more than one char, so they never masquerade as a keypress.
      var prevEditText = "";
      try { prevEditText = String(box.plainText); } catch (e) {}
      box.textChanged.connect(function () {
        if (editingNoteId !== note.id) {        // programmatic reset / locked
          try { prevEditText = String(box.plainText); } catch (e) {}
          return;
        }
        sizeNoteInput(box); // auto-grow while typing
        try {
          var t = String(box.plainText);
          if (isEnterKeypress(prevEditText, t)) {
            trace("Enter via fallback (edit box) — saving");
            finishEdit(true, prevEditText); // save the pre-newline text
            return;
          }
          if (looksLikeEnter(prevEditText, t)) {
            trace("newline kept (edit box) — shift detected"); // diagnostics
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

      // ---- click-to-jump (v0.32.0): the whole note card is a jump target.
      // ✕/✎/○ and the editor consume their own clicks, so they're exempt.
      // The text label is SELECTION-AWARE: a plain click jumps, a drag-
      // select keeps working and never jumps (checked at mouse release).
      if (frameNo > 0) {
        armClickJump(card, drawingName, frameNo, note.id, null);
        armClickJump(meta, drawingName, frameNo, note.id, null);
        armClickJump(textLbl, drawingName, frameNo, note.id, textLbl);
        try { card.cursor = new QCursor(Qt.PointingHandCursor); } catch (e) {}
        setArrowCursor(delBtn);
        setArrowCursor(editBtn);
        setArrowCursor(doneBtn);
      }

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
    // trailing-"\n" check only caught Enter at the END of the text, which
    // the add box always satisfies (cursor lives at the end) but editing
    // almost never does — so mid-line Enter inserted a newline instead of
    // saving (v0.28.2). A lone Enter adds exactly one char and exactly one
    // newline; pastes and normal typing don't match. Shift is read from
    // the live keyboard state, the same mechanism the add box has trusted
    // since v0.7.
    function countNewlines(s) {
      var n = 0;
      for (var i = 0; i < s.length; i++) if (s.charAt(i) === "\n") n++;
      return n;
    }
    function looksLikeEnter(prev, now) {
      return now.length === prev.length + 1 &&
             countNewlines(now) === countNewlines(prev) + 1;
    }
    function isEnterKeypress(prev, now) {
      if (!looksLikeEnter(prev, now)) return false;
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
                if (event.modifiers() & Qt.ShiftModifier) {
                  trace("Shift+Enter via key filter — newline"); // diagnostics
                  return false;
                }
                trace("Enter via key filter — saving"); // diagnostics: filter alive!
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

    // ---- click-to-jump (v0.32.0 — revival of v0.8.x) --------------------
    // History: the v0.8.x "clicks randomly die" bug was the GC collecting
    // filter wrappers, fixed then (and doctrine ever since) by keep-alive
    // pinning. What made the feature FEEL unreliable was the patchwork:
    // selectable text consumed its clicks while the background jumped.
    // This build arms the text label too — selection-aware, so dragging
    // to select never jumps but a plain click does.
    //
    // Filters NEVER consume the event (return false always): buttons,
    // links, text selection, and the editor keep their native behavior;
    // we only listen. Acting on mouse RELEASE (a click's end) lets the
    // selection check see the drag's result.
    function armClickJump(w, dn, shownFrame, noteId, selLabel) {
      var f = makeClickJumpFilter(dn, shownFrame, noteId, selLabel);
      if (!f) return;
      try { w.installEventFilter(f); clickJumpArmed++; } catch (e) {}
    }

    // Children with no explicit cursor INHERIT the card's pointing hand
    // (Qt cursor inheritance) — buttons should keep the default arrow.
    function setArrowCursor(w) {
      try { w.cursor = new QCursor(Qt.ArrowCursor); } catch (e) {}
    }

    function makeClickJumpFilter(dn, shownFrame, noteId, selLabel) {
      try {
        var f = new QObject(dlg);
        f.eventFilter = function (watched, event) {
          try {
            // Numeric fallbacks (v0.8.1 hardening): QEvent/Qt enums may be
            // unbound on some engines; MouseButtonRelease is 3, LeftButton
            // is 1 in every Qt.
            var t = -1;
            try { t = Number(event.type()); } catch (e0) { return false; }
            var rel = 3;
            try { rel = Number(QEvent.MouseButtonRelease) || 3; } catch (e1) {}
            if (t !== rel) return false;
            try {
              var left = 1;
              try { left = Number(Qt.LeftButton) || 1; } catch (e2) {}
              if (Number(event.button()) !== left) return false;
            } catch (e3) { /* button unreadable: assume left click */ }
            if (noteId !== null && editingNoteId === noteId) {
              return false; // never yank the playhead mid-edit
            }
            if (selLabel) {
              var sel = true; // unreadable state = assume selecting (no jump)
              try {
                sel = selLabel.hasSelectedText;
                if (typeof sel === "function") sel = selLabel.hasSelectedText();
                sel = (sel === true);
              } catch (e4) { sel = true; }
              if (sel) {
                trace("click-jump: skipped — text selection active");
                return false;
              }
            }
            // One jump per physical click: the release bubbles through
            // nested cards (note card -> group card), so sibling filters
            // may see the same event within the same instant.
            var nowMs = (new Date()).getTime();
            if (nowMs - lastJumpMs < 200) return false;
            lastJumpMs = nowMs;
            trace("click-jump: Sub " + dn + " via " +
                  (selLabel ? "note text" : "card"));
            makeJumpToSub(dn, shownFrame)();
          } catch (e) { /* clicking must never break the panel */ }
          return false; // never consume — we only listen
        };
        g_snKeepAlive.push(f); // pin or GC kills the override (v0.8.2 lesson)
        return f;
      } catch (e) {
        return null; // engine can't build filters: links still navigate
      }
    }

    // ---- Auto Mode (v0.34.0) -------------------------------------------
    // The Create-phase loop, de-clunked: timeline click → one lazy click on
    // any EMPTY list space → the note prompt appears at the playhead with
    // the input already focused → type → Enter. No button sniping. Cards,
    // buttons, links, and text keep their exact Manual behavior — the auto
    // filter only reacts to clicks nothing else claimed.

    // Create (or reuse) the sub at the playhead and put the cursor in its
    // add box — the Add Note button's flow plus focus.
    function autoAddAtPlayhead() {
      var f = frame.current();
      cleanupPendingAuto(f); // an empty prompt at another frame dies now
      var dn = ensureSubstitutionAtFrame(layer, f);
      if (!dn) return;
      autoPending = { drawing: dn, frame: f };
      trace("auto mode: note prompt at frame " + f + " (sub " + dn + ")");
      refresh(dn); // scroll to + flash, same as the Add Note button
      focusAddInput(dn);
    }

    // Abandon an untouched Auto prompt: remove the sub again as if it was
    // never created. Same AND-rule as the launch sweep — any note, any
    // draft text (live or stashed), or any art means it's real and stays.
    // exceptFrame: keep a prompt at that frame (it's being re-used).
    // quiet: skip the refresh (panel is closing).
    function cleanupPendingAuto(exceptFrame, quiet) {
      if (!autoPending) return;
      if (exceptFrame !== undefined && autoPending.frame === exceptFrame) return;
      var dn = autoPending.drawing;
      var atFrame = autoPending.frame;
      autoPending = null;
      try {
        if (notesFor(model, layer.elementId, dn).length > 0) return;
        var draft = "";
        try {
          if (liveInputs[dn]) draft = String(liveInputs[dn].plainText);
        } catch (e0) {}
        if (draft.replace(/^\s+|\s+$/g, "") !== "") return; // half-typed
        if (drafts[dn]) return;                             // stashed draft
        var bytes = drawingArtBytes(layer.elementId, dn);
        if (bytes < 0 || bytes > SN_EMPTY_TVG_BYTES) return; // has art
        removeSubstitution(layer, dn);
        try {
          var eid = String(layer.elementId);
          if (model.notesByDrawing[eid]) delete model.notesByDrawing[eid][dn];
        } catch (e1) {}
        saveModel(model);
        trace("auto mode: empty prompt at frame " + atFrame + " cleaned up");
        if (!quiet) refresh();
      } catch (e) { /* the launch sweep is the backstop */ }
    }

    // ---- Auto v2 (beta.10): the prompt FOLLOWS THE PLAYHEAD ------------
    // No click-in/click-out: when the playhead settles (debounced), a
    // VIRTUAL prompt card renders at that frame. No sub is created until
    // the note commits — scrubbing writes NOTHING to the scene, and an
    // abandoned prompt costs nothing (there is nothing to clean up).

    function makeVirtualCard(vf) {
      var card = new QFrame();
      card.frameShape = QFrame.StyledPanel;
      liveVirtualCard = card;
      liveGroups["__prompt__"] = card; // scroll/flash machinery lookup key
      var v = new QVBoxLayout(card);

      var head = new QLabel(
        '<span style="color: ' + SN_GREEN + '; font-weight: bold;">Frame ' +
        vf + "</span>");
      try { head.textInteractionFlags = Qt.NoTextInteraction; } // click-through
      catch (e) { try { head.textInteractionFlags = 0; } catch (e2) {} }
      addW(v, head);

      var rowW = new QWidget();
      var row = new QHBoxLayout(rowW);
      row.setContentsMargins(0, 0, 0, 0);
      var input = new QTextEdit();
      try { input.acceptRichText = false; } catch (e) {}
      try { input.placeholderText = "Add note…"; } catch (e) {}
      liveVirtualInput = input;
      if (virtualDraft) { // a rebuild interrupted typing: restore it
        try { input.plainText = virtualDraft; } catch (e) {}
        virtualDraft = null;
      }
      sizeNoteInput(input);
      var noteBtn = new QPushButton("Add");
      addW(row, input, 1);
      addW(row, noteBtn);
      addW(v, rowW);

      function commitVirtual(explicitText) {
        var txt = (explicitText !== undefined) ? explicitText : "";
        if (explicitText === undefined) {
          try { txt = String(input.plainText); } catch (e) {}
        }
        txt = txt.replace(/^\s+|\s+$/g, "");
        if (txt === "") return;
        // The sub is born HERE — at commit time, not prompt time.
        var dn = ensureSubstitutionAtFrame(layer, vf);
        if (!dn) return;
        addNote(model, layer.elementId, dn, txt);
        saveModel(model);
        virtualDraft = null;
        try { input.plainText = ""; } catch (e) {}
        trace("auto: note committed at frame " + vf + " (sub " + dn + ")");
        refresh(dn);
        // Hand the keyboard back to Harmony so its shortcuts work again.
        if (SN_AUTO_FOCUS === "steal") {
          try { var mw = mainWindow(); if (mw) mw.activateWindow(); } catch (e) {}
        }
      }
      noteBtn.clicked.connect(function () { commitVirtual(); });

      var kf = makePromptKeyFilter(input, function () { commitVirtual(); });
      if (kf) { try { input.installEventFilter(kf); } catch (e) {} }
      var prevTxt = "";
      try { prevTxt = String(input.plainText); } catch (e) {}
      input.textChanged.connect(function () {
        sizeNoteInput(input);
        try {
          var t = String(input.plainText);
          if (isEnterKeypress(prevTxt, t)) {
            trace("Enter via fallback (prompt box) — saving");
            commitVirtual(prevTxt);
            return;
          }
          prevTxt = t;
        } catch (e) { /* typing must never break */ }
      });

      return card;
    }

    // Enter machinery + SCRUB PASSTHROUGH (user concern: < > scrubbing
    // must survive the focus steal): while the prompt box is EMPTY, the
    // frame-step keys — , . < > and the left/right arrows — act as real
    // frame steps instead of typing. A box with text types normally.
    function makePromptKeyFilter(input, commitFn) {
      try {
        var f = new QObject(dlg);
        f.eventFilter = function (watched, event) {
          try {
            if (event.type() === QEvent.KeyPress) {
              var k = event.key();
              if (k === Qt.Key_Return || k === Qt.Key_Enter) {
                if (event.modifiers() & Qt.ShiftModifier) return false;
                commitFn();
                return true;
              }
              var empty = false;
              try {
                empty = String(input.plainText).replace(/\s/g, "") === "";
              } catch (e0) {}
              if (empty) {
                function K(name, dflt) {
                  try { return Number(Qt[name]) || dflt; }
                  catch (e) { return dflt; }
                }
                var dir = 0;
                if (k === K("Key_Comma", 44) || k === K("Key_Less", 60) ||
                    k === K("Key_Left", 16777234)) dir = -1;
                else if (k === K("Key_Period", 46) ||
                         k === K("Key_Greater", 62) ||
                         k === K("Key_Right", 16777236)) dir = 1;
                if (dir !== 0) {
                  lastKeyScrubMs = (new Date()).getTime(); // hold the rebuild
                  var nf = frame.current() + dir;
                  if (nf >= 1 && nf <= frame.numberOf()) frame.setCurrent(nf);
                  return true; // consumed: it scrubbed, it doesn't type
                }
              }
            }
          } catch (e) { /* never block typing */ }
          return false;
        };
        g_snKeepAlive.push(f); // pin or GC kills the override
        return f;
      } catch (e) { return null; }
    }

    // The playhead settled somewhere new: move the prompt — unless the
    // box holds half-typed text (typing is intent; never yank a draft
    // out from under the user). Returns true when the prompt moved.
    function syncPromptFrame() {
      if (snMode !== "auto") return false;
      var f = -1;
      try { f = frame.current(); } catch (e) { return false; }
      if (f <= 0 || f === promptFrame) return false;
      try {
        if (liveVirtualInput &&
            String(liveVirtualInput.plainText)
              .replace(/^\s+|\s+$/g, "") !== "") {
          return false; // draft in progress: the prompt stays put
        }
      } catch (e) {}
      promptFrame = f;
      return true;
    }

    // Scroll to + flash the prompt and (policy "steal") move the keyboard
    // into its box — skipped while a mouse button is down, so a timeline
    // drag is never interrupted mid-hold. Uses focusGroup, whose RETRIED
    // scrolls (now/60ms/250ms) survive the post-rebuild window where card
    // positions are still garbage — a one-shot scroll stops short on long
    // jumps (the 82→4 bug).
    function focusPrompt() {
      if (snMode !== "auto") return;
      var key = promptTargetDrawing ? promptTargetDrawing : "__prompt__";
      try { focusGroup(key); } catch (e) {}
      if (SN_AUTO_FOCUS !== "steal") return;
      try {
        var mb = 0;
        try { mb = Number(QApplication.mouseButtons()); } catch (e0) {}
        if (mb) return; // mid-drag: show the prompt, don't steal
      } catch (e) {}
      try { dlg.activateWindow(); } catch (e) {}
      if (promptTargetDrawing) {
        focusAddInput(promptTargetDrawing);
      } else if (liveVirtualInput) {
        try { liveVirtualInput.setFocus(); }
        catch (e0) { try { liveVirtualInput.setFocus(7); } catch (e1) {} }
      }
    }

    // Focus a group's add box so typing works immediately. Asserted twice:
    // right after the rebuild, and again once layout settles (the same
    // timing reality focusGroup's re-scrolls handle).
    function focusAddInput(dn) {
      function grab() {
        try {
          var box = liveInputs[dn];
          if (!box) return;
          try { box.setFocus(); }
          catch (e0) { try { box.setFocus(7); } catch (e1) {} } // 7 = OtherFocusReason
        } catch (e) {}
      }
      grab();
      try {
        var t;
        try { t = new QTimer(dlg); } catch (e0) { t = new QTimer(); }
        g_snKeepAlive.push(t);
        t.singleShot = true;
        t.timeout.connect(grab);
        t.start(80);
      } catch (e) { /* first grab already did its best */ }
    }

    // Background-click filter, installed on BOTH the list host and the
    // dialog itself (beta.2): a click nothing interactive claims bubbles
    // up to whichever of the two owns that region — list interior to the
    // host, everything else (toolbar gaps, bottom strip, window margins)
    // to the dialog. beta.1 only listened on the host, so the add-surface
    // shrank to the space below the cards as the list filled. Both can
    // see the same bubbled click; lastAutoMs makes it one add. A click a
    // card claimed set lastJumpMs microseconds ago (child filters run
    // before the event bubbles here) — that click means "jump", never
    // "add". (Panel-lifetime: host and dlg survive refreshes.)
    try {
      // Press fallback (beta.6): Zack's logs proved Harmony sometimes
      // delivers a background click's PRESS but never its RELEASE
      // (press–press–silence in the bottom region), so release-only
      // triggering lost those clicks. Every background press arms a
      // 250 ms timer; if no release, jump, or add follows, the press
      // itself completes the click. Presses that bubbled up from a card
      // are safe: their release fires the jump, and the timer sees
      // lastJumpMs move and stands down.
      var pressTimer = null;
      var pressAt = 0;
      function schedulePressFallback(ms) {
        pressAt = ms;
        try {
          if (!pressTimer) {
            try { pressTimer = new QTimer(dlg); }
            catch (e0) { pressTimer = new QTimer(); }
            pressTimer.singleShot = true;
            pressTimer.timeout.connect(function () {
              try {
                if (snMode === "manual") return;
                if (lastAutoMs >= pressAt || lastJumpMs >= pressAt) return;
                lastAutoMs = (new Date()).getTime();
                trace("auto click: release never delivered — press fallback");
                if (snMode === "hybrid") autoAddAtPlayhead();
                else focusPrompt();
              } catch (e) {}
            });
            g_snKeepAlivePanel.push(pressTimer);
          }
          pressTimer.stop();
          pressTimer.start(250);
        } catch (e) { /* release path still active */ }
      }

      var autoF = new QObject(dlg);
      autoF.eventFilter = function (watched, event) {
        try {
          if (snMode === "manual") return false; // classic: clicks do nothing
          var t = -1;
          try { t = Number(event.type()); } catch (e0) { return false; }
          var rel = 3;
          try { rel = Number(QEvent.MouseButtonRelease) || 3; } catch (e1) {}
          var prs = 2;
          try { prs = Number(QEvent.MouseButtonPress) || 2; } catch (e1b) {}
          if (t !== rel && t !== prs) return false;
          try {
            var left = 1;
            try { left = Number(Qt.LeftButton) || 1; } catch (e2) {}
            if (Number(event.button()) !== left) return false; // left only
          } catch (e3) { /* button unreadable: assume left */ }
          // beta.4 diagnostics: log the pipeline so a dead click shows
          // WHERE it died (no press = event never delivered; press but no
          // release = release eaten; guard lines = skipped on purpose).
          var who = (watched === host) ? "host"
                  : (watched === verLbl) ? "version"
                  : (watched === stretchW) ? "strip gap"
                  : (watched === bottomW) ? "bottom strip"
                  : (watched === toolbarW) ? "toolbar"
                  : "dlg";
          var nowMs = (new Date()).getTime();
          if (t === prs) {
            trace("auto click: press on " + who);
            schedulePressFallback(nowMs);
            return false;
          }
          if (nowMs - lastJumpMs < 300) {
            trace("auto click: release on " + who + " — skipped (jump claimed it)");
            return false;
          }
          if (nowMs - lastAutoMs < 300) {
            trace("auto click: release on " + who + " — skipped (already added)");
            return false;
          }
          lastAutoMs = nowMs;
          if (snMode === "hybrid") {
            trace("auto click: release on " + who + " — adding (hybrid)");
            autoAddAtPlayhead();
          } else {
            trace("auto click: release on " + who + " — focusing prompt");
            focusPrompt();
          }
        } catch (e) { /* clicking must never break the panel */ }
        return false; // never consume — we only listen
      };
      host.installEventFilter(autoF);
      try { dlg.installEventFilter(autoF); } catch (e9) {}
      // §38's lesson applied forward (beta.5): widgets that might swallow
      // unclaimed clicks get the filter DIRECTLY — it never consumes, so
      // arming broadly is free. (Deliberately NOT on card widgets: their
      // jump filters would race this one on the same release.)
      try { toolbarW.installEventFilter(autoF); } catch (e9a) {}
      try { bottomW.installEventFilter(autoF); } catch (e9b) {}
      try { verLbl.installEventFilter(autoF); } catch (e9c) {}
      try { stretchW.installEventFilter(autoF); } catch (e9d) {}
      g_snKeepAlivePanel.push(autoF);
    } catch (e) {
      trace("auto mode: click filter unavailable (" + e + ") — Add Note " +
            "button still works");
    }

    // Title-bar re-entry (beta.3): the OS owns the title bar — its clicks
    // never reach Qt on ANY engine, so no filter can hear them. Geometry
    // is the side door: when the window ACTIVATES in Auto Mode and the
    // cursor sits in the title band (inside the frame, above the client
    // area), the activation click was the title bar — treat it as an add.
    // Known quirk, accepted: grabbing an INACTIVE panel's title bar to
    // drag it also adds (the empty prompt self-cleans on the next
    // deactivate/playhead move). All bindings first-use and guarded —
    // failure = title bar stays add-deaf, everything else unaffected.
    var titleWarned = false;
    function maybeTitleBarAdd() {
      // Geometry test in its own try (beta.6): the add call used to live
      // inside it too, so a refresh error was mislabeled "title-bar
      // detection unavailable" AND aborted the add midway.
      var inTitle = false;
      try {
        var p = QCursor.pos();
        var px = (typeof p.x === "function") ? p.x() : p.x;
        var py = (typeof p.y === "function") ? p.y() : p.y;
        function rv(r, name) { // QRect members bind as props OR functions
          var v = r[name];
          return Number((typeof v === "function") ? r[name]() : v);
        }
        var fg = dlg.frameGeometry; // window incl. decorations
        var g = dlg.geometry;       // client area only
        var fX = rv(fg, "x");
        var fT = rv(fg, "y");
        var fR = fX + rv(fg, "width");
        var cT = rv(g, "y");        // client top = below the title bar
        trace("activate: cursor=(" + px + "," + py + ") frameTop=" + fT +
              " clientTop=" + cT + " x-range=" + fX + ".." + fR);
        inTitle = (px >= fX && px <= fR && py >= fT && py < cT);
      } catch (e) {
        if (!titleWarned) {
          titleWarned = true;
          trace("auto mode: title-bar detection unavailable (" + e + ")");
        }
        return;
      }
      if (!inTitle) return;
      var nowMs = (new Date()).getTime();
      if (nowMs - lastAutoMs < 300) return;
      lastAutoMs = nowMs;
      trace("auto mode: title-bar re-entry — note prompt");
      autoAddAtPlayhead();
    }

    // Window watcher: DEACTIVATE abandons an empty prompt (spec: leaving
    // the window = never mind); ACTIVATE runs the title-bar check above.
    // Guarded first-use bindings — if these events never arrive on this
    // engine, the playhead-move cleanup in the staleness timer remains.
    try {
      var winF = new QObject(dlg);
      winF.eventFilter = function (watched, event) {
        try {
          var t = -1;
          try { t = Number(event.type()); } catch (e0) { return false; }
          var dea = 25;
          try { dea = Number(QEvent.WindowDeactivate) || 25; } catch (e1) {}
          var act = 24;
          try { act = Number(QEvent.WindowActivate) || 24; } catch (e2) {}
          if (t === dea && snMode === "hybrid" && autoPending) {
            trace("hybrid: window deactivated with an empty prompt");
            cleanupPendingAuto();
          } else if (t === act && snMode === "hybrid") {
            maybeTitleBarAdd(); // title-bar clicks never reach Qt: geometry
          } else if (t === act && snMode === "auto") {
            focusPrompt(); // entering the window = ready to type
          }
        } catch (e) {}
        return false;
      };
      dlg.installEventFilter(winF);
      g_snKeepAlivePanel.push(winF);
    } catch (e) { /* lazy cleanup paths remain */ }

    addBtn.clicked.connect(function () {
      var f = frame.current();
      var drawingName = ensureSubstitutionAtFrame(layer, f);
      if (drawingName) {
        refresh(drawingName); // scroll to + flash the new group
        focusAddInput(drawingName); // cursor ready in both modes (v0.34.0)
      }
    });

    // Scrub the playhead between note frames, anchored to wherever the
    // playhead currently is (frames recomputed live so new subs count).
    // EVERY exposure span's start is a stop (v0.33.0, user spec): a sub
    // re-exposed at frame 87 is a review location in its own right.
    function scrubToNoteFrame(dir) {
      var f = frame.current();
      var groups = collectGroups(layer, model);
      var best = -1;
      var bestDrawing = "";
      for (var i = 0; i < groups.length; i++) {
        var spans = groups[i].spans || [];
        for (var s = 0; s < spans.length; s++) {
          var g = spans[s].first;
          if (g <= 0) continue;
          if (dir > 0 && g > f && (best < 0 || g < best)) { best = g; bestDrawing = groups[i].drawing; }
          if (dir < 0 && g < f && (best < 0 || g > best)) { best = g; bestDrawing = groups[i].drawing; }
        }
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
              // AUTO: while the scrub keys are actively firing, hold ALL
              // rebuild work — a rebuild mid-hold destroys the focused
              // prompt box and the held key dies with it. The prompt
              // appears once scrubbing pauses (user spec).
              if (snMode === "auto" &&
                  ((new Date()).getTime() - lastKeyScrubMs) < 700) {
                scheduleStalenessCheck();
                return;
              }
              // HYBRID: playhead moved away from an untouched prompt —
              // the user moved on; abandon it. A prompt at the CURRENT
              // frame is the one being worked on; keep it.
              if (snMode === "hybrid") cleanupPendingAuto(frame.current());
              // AUTO: the prompt follows the settled playhead.
              var promptMoved = syncPromptFrame();
              if (groupsSignature() !== shownSig) {
                trace("timeline changed under the panel (via " + lastSignal +
                      ") — auto-refreshing");
                refresh(); // refresh() updates the scrub buttons too
                if (promptMoved) focusPrompt();
              } else if (promptMoved) {
                refresh(); // re-render: the virtual card moves frames
                focusPrompt();
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
                     ? "Frame " + spanText(g.spans)
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

    // ---- self-updater (v0.30.0, KB §36) --------------------------------
    // At every launch, quietly download the release-branch script to temp
    // (curl via Process2 — probe-proven; curl ships on Win10+ AND macOS,
    // one identical command). A timer then verifies the download REALLY is
    // our script before anything else happens: a 404/proxy page can never
    // touch the installed file (curl -f writes nothing on HTTP errors, and
    // content is sniffed anyway). Newer version → the status bar's version
    // text becomes a "New Update Available" link → confirm → install →
    // "restart Harmony". First-ever launch on a machine force-updates once
    // (preferences flag, set only after a SUCCESSFUL check or install).
    var updateTmp = "";
    var updateRemote = null; // { version, content } once verified

    function versionNewer(remote, local) {
      var r = String(remote).split(".");
      var l = String(local).split(".");
      for (var i = 0; i < Math.max(r.length, l.length); i++) {
        var a = parseInt(r[i], 10) || 0;
        var b = parseInt(l[i], 10) || 0;
        if (a !== b) return a > b;
      }
      return false;
    }

    function readWholeFile(path) {
      try {
        var f = new File(path);
        f.open(1); // read mode — probe-proven
        var s = String(f.read());
        f.close();
        return s;
      } catch (e) { return null; }
    }

    function cleanupUpdateTmp() {
      try { new File(updateTmp).remove(); } catch (e) { /* temp junk */ }
    }

    function startUpdateCheck() {
      try {
        var tmpDir = "";
        try { tmpDir = String(specialFolders.temp); } catch (e0) {}
        if (!tmpDir) { trace("update check skipped: no temp folder"); return; }
        // Unique name per run: stale files from old runs can't be misread.
        updateTmp = tmpDir + "/syncnote_update_" + (new Date()).getTime() + ".js";
        var cmd = 'curl -f -L -s -o "' + updateTmp + '" "' + SN_UPDATE_URL + '"';
        try { new Process2(cmd).launch(); }
        catch (e1) { trace("update check: could not launch curl (" + e1 + ")"); return; }
        var t;
        try { t = new QTimer(dlg); } catch (e2) { t = new QTimer(); }
        g_snKeepAlivePanel.push(t);
        t.singleShot = true;
        t.timeout.connect(onUpdateDownloaded);
        t.start(4000); // probe: download completed in <1s; generous slack
        trace("update check: querying the release channel…");
      } catch (e) { trace("update check error (" + e + ")"); }
    }

    function onUpdateDownloaded() {
      try {
        if (!(new QFileInfo(updateTmp).exists())) {
          trace("update check: no response (offline or channel unavailable) — will retry next launch");
          return;
        }
        var content = readWholeFile(updateTmp);
        if (!content || content.indexOf("function SyncNote") < 0) {
          trace("update check: download failed verification — ignored");
          cleanupUpdateTmp();
          return;
        }
        var m = content.match(/SN_VERSION\s*=\s*"([^"]+)"/);
        if (!m) {
          trace("update check: no version in download — ignored");
          cleanupUpdateTmp();
          return;
        }
        var remoteVer = m[1];
        if (!versionNewer(remoteVer, SN_VERSION)) {
          trace("update check: up to date (release has v" + remoteVer + ")");
          cleanupUpdateTmp();
          return;
        }
        // v0.30.4 (user design): ALWAYS auto-update — no ask, no first-run
        // flag (whose preferences persistence proved unreliable across
        // restarts anyway). The dialog afterward only offers WHEN to start
        // using the new version: relaunch now, or finish on the old one.
        updateRemote = { version: remoteVer, content: content };
        trace("newer release v" + remoteVer + " — auto-updating");
        doInstall();
      } catch (e) { trace("update processing error (" + e + ")"); }
    }

    function verifyInstalled(target) {
      var check = readWholeFile(target);
      if (!check || check.indexOf("function SyncNote") < 0) return false;
      var m = check.match(/SN_VERSION\s*=\s*"([^"]+)"/);
      return !!(m && m[1] === updateRemote.version);
    }

    function reportInstall(ok) {
      if (ok) {
        cleanupUpdateTmp();
        trace("updated to v" + updateRemote.version + " — relaunch to load it");
        // Post-update choice (v0.30.4, user design): the update is already
        // installed; the only question is when to start using it. Modal
        // child dialog — Escape rejects only this dialog (= Keep Working).
        try {
          var d = new QDialog(dlg);
          d.setWindowTitle("SyncNote Update");
          d.minimumWidth = 340;
          var v = new QVBoxLayout(d);
          var lbl = new QLabel(
            "SyncNote has been updated.\n\n" +
            "v" + SN_VERSION + "  →  v" + updateRemote.version + "\n\n" +
            "Relaunch SyncNote to use the new version, or keep working.\n" +
            "This window stays on v" + SN_VERSION + " until relaunched.");
          lbl.wordWrap = true;
          addW(v, lbl);
          var rowW = new QWidget();
          var row = new QHBoxLayout(rowW);
          row.setContentsMargins(0, 0, 0, 0);
          var closeBtn = new QPushButton("Close SyncNote");
          try { closeBtn.setProperty("default", true); } catch (e0) {}
          closeBtn.clicked.connect(function () { d.accept(); });
          var laterBtn = new QPushButton("Keep Working");
          try { laterBtn.setProperty("autoDefault", false); } catch (e1) {}
          laterBtn.clicked.connect(function () { d.reject(); });
          addW(row, closeBtn);
          addW(row, laterBtn);
          addW(v, rowW);
          if (d.exec()) {
            dlg.close(); // routes through save-on-close; relaunch = new version
          } else {
            trace("user kept the old version running for this session");
          }
        } catch (e) {}
      } else {
        trace("UPDATE FAILED: could not write the new version — install manually");
        try {
          MessageBox.information(
            "The update could not be installed automatically.\n" +
            "Please download the latest version manually.");
        } catch (e) {}
      }
    }

    function doInstall() {
      if (!updateRemote) return;
      var target = "";
      try { target = String(specialFolders.userScripts) + "/SyncNote.js"; }
      catch (e0) {}
      if (!target) { trace("update install: no userScripts folder"); return; }

      // Attempt 1: direct File write (cross-platform; unproven binding —
      // the readback below is the arbiter, not the API's word).
      try {
        var f = new File(target);
        f.open(2); // write mode
        f.write(updateRemote.content);
        f.close();
      } catch (e1) { /* verified below */ }
      if (verifyInstalled(target)) { reportInstall(true); return; }

      // Attempt 2: OS copy of the already-verified temp file (Process2 is
      // probe-proven), then re-verify after a beat.
      trace("update install: File.write didn't verify — trying OS copy");
      var copyCmd;
      var win = false;
      try { win = about.isWindowsArch(); } catch (e2) {}
      if (win) {
        copyCmd = 'cmd /c copy /Y "' + updateTmp.replace(/\//g, "\\") + '" "' +
                  target.replace(/\//g, "\\") + '"';
      } else {
        copyCmd = 'cp -f "' + updateTmp + '" "' + target + '"';
      }
      try { new Process2(copyCmd).launch(); }
      catch (e3) { reportInstall(false); return; }
      var vt;
      try { vt = new QTimer(dlg); } catch (e4) { vt = new QTimer(); }
      g_snKeepAlivePanel.push(vt);
      vt.singleShot = true;
      vt.timeout.connect(function () {
        reportInstall(verifyInstalled(target));
      });
      vt.start(2000);
    }

    // BETA: no update check — the beta must never touch the installed
    // SyncNote.js, and its version string would confuse the comparison.
    trace("beta build — update check disabled");

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
        // An untouched Auto prompt dies with the panel (quiet: no rebuild
        // of a closing dialog) — before the dirty check, so the removal
        // itself is included in the save below.
        try { cleanupPendingAuto(undefined, true); } catch (e1) {}
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
    // Open AT the minimum width (v0.31.3): Qt otherwise opens new windows
    // at the content's size hint, which is wider than our minimum — so the
    // status bar wrapped differently on a fresh open vs. after the user
    // nudged the edge to the true minimum. Guarded: failure = hint sizing.
    try { dlg.resize(dlg.minimumWidth, 560); } catch (e) {}
    dlg.show();
    dlg.raise();
    dlg.activateWindow();
  }

  // =======================================================================
  // UTILITIES
  // =======================================================================
  // Every step guarded (beta.6): a single already-deleted widget in the
  // layout used to throw ("cannot access member 'hide' of deleted
  // QObject") and ABORT the whole teardown mid-refresh — the list stayed
  // half-built and the post-refresh scroll/focus never ran. One dead
  // widget must never cost the rest of the rebuild.
  function clearLayout(layout) {
    if (!layout) return;
    var item = null;
    try { item = layout.takeAt(0); } catch (e) { return; }
    while (item) {
      try {
        var w = item.widget();
        if (w) {
          try { w.hide(); } catch (eH) { /* already deleted: fine */ }
          try { w.deleteLater(); } catch (eD) {}
        }
      } catch (e0) {}
      try {
        var child = item.layout();
        if (child) clearLayout(child);
      } catch (e1) {}
      try { item = layout.takeAt(0); } catch (e2) { item = null; }
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
