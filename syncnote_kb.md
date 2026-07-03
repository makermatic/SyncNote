# SyncNote Knowledge Base

A working reference for building **SyncNote** — a Toon Boom Harmony script (like Frame.io / SyncSketch) that attaches text review notes to drawing substitutions inside a scene.

This document has two jobs:
1. **Reference** — how Harmony scripting works (JS/Qt Script, nodes/elements/columns, drawing substitutions, element IDs, data storage, resizable Qt dialogs).
2. **Design log** — what we're building and why, updated as we go.

> ⚠️ **Verification status.** API signatures below are drawn from the official Toon Boom scripting docs (Harmony 20–24) and confirmed patterns. A handful of calls are marked **[verify in app]** — these should be smoke-tested in the Harmony Script Editor before relying on them, because exact argument order occasionally differs between versions. See [Sources](#sources).

---

## 1. Harmony scripting fundamentals

### 1.1 The language
- Harmony's scripting is **Qt Script**, an ECMAScript dialect ≈ JavaScript (roughly ES5 + Qt bindings). No `let`/`const` guarantees on older versions — prefer `var`.
- Two flavors exist: **Qt Script (JS)** and a newer **Python** interface. This project targets **Qt Script (JS)** because the UI (Qt widgets) and the classic global objects are most stable there.
- Scripts live in `.js` files. User scripts folder (Windows):
  `%APPDATA%/Toon Boom Animation/Toon Boom Harmony <ver>/<ver>-scripts/`
  Accessible in code via the `specialFolders` global (e.g. `specialFolders.userScripts`).
- A script is invoked by a **top-level function whose name matches the file name**. `SyncNote.js` → `function SyncNote(){ ... }`. Harmony calls that function when the toolbar button is pressed.

### 1.2 Global objects you'll use
| Global | Purpose |
|---|---|
| `scene` | scene-wide info, project paths, **metadata storage** |
| `node` | create/query/link nodes (READ, groups, etc.) |
| `column` | read/write column cells — this is where drawing exposure lives |
| `element` | physical drawing folders + **element IDs** |
| `Drawing` | create/copy/query individual drawings |
| `frame` | frame count, current frame, move playhead |
| `selection` | current node/frame selection |
| `MessageBox`, `Dialog` | simple built-in dialogs |
| `specialFolders`, `preferences`, `about` | environment/paths/user prefs |
| `scene.beginUndoRedoAccum` / `endUndoRedoAccum` | wrap scene edits in one undo step |

### 1.3 Undo safety (important)
Any script that mutates the scene (adds nodes/columns/drawings/exposure) should wrap the mutation:
```javascript
scene.beginUndoRedoAccum("SyncNote: add note point");
// ... create element / column / node / exposure ...
scene.endUndoRedoAccum();
```
This makes the whole operation a single Ctrl+Z and prevents half-finished states.

---

## 2. The data model: Nodes ↔ Elements ↔ Columns ↔ Drawings

This is the single most important mental model for SyncNote. These are **three separate things** that get linked together:

```
 READ node ("Notes")            <- what you see in Node View / Timeline; has a name (renameable)
      │  linkAttr("DRAWING.ELEMENT", column)
      ▼
 Drawing column ("Notes")       <- the exposure track: which drawing shows on which frame
      │  getElementIdOfDrawing() -> elementId
      ▼
 Element  (id = 42)             <- a physical folder of drawing files (.tvg); STABLE integer id
      │  contains
      ▼
 Drawings ("1","2","note_a"...) <- individual drawings, referenced by name/timing string
```

Key facts:
- A **READ node** is the visible layer. Its *name* is cosmetic and renameable — **do not key data off it.**
- A READ node exposes a **drawing column** through its `DRAWING.ELEMENT` attribute.
- Every drawing column is backed by an **element**, which has a unique **integer element ID** (`element.id`) that does *not* change when you rename the node, column, or element. Docs: *"each element has ... an integer id (key of the element in the database) which is unique. Their name is not guaranteed to be unique."*
- Inside an element, individual **drawings** are referenced by a **timing/name string** (e.g. `"1"`, `"2"`, `"note_a"`). A cell in the column holds that string.

**Design consequence:** SyncNote binds notes to the **element ID + drawing name**, never to the READ node name. Renaming the layer or the scene leaves the binding intact. ✅ (This matches exactly what you asked for.)

---

## 3. Drawing substitutions via script

"Drawing substitution" in the Harmony UI = choosing which drawing is exposed on a given cell. Under the hood that's just the **string value of a cell in the drawing column**.

### 3.1 Reading what's exposed at a frame
```javascript
// column: drawing column name; sub-column is 1 for drawing columns
var drawingName = column.getEntry(columnName, 1, atFrame); // -> "3" (string), "" if empty
```
- `String getEntry(String columnName, int subColumnIndex, double atFrame)`
- For drawing columns `subColumnIndex` is always `1`.

### 3.2 Setting / substituting the drawing at a frame
```javascript
column.setEntry(columnName, 1, atFrame, drawingName); // expose drawingName at that frame
```
- `bool setEntry(String columnName, int subColumn, double atFrame, String value)`
- Writing a drawing name that already exists in the element = a **substitution** (swap). Writing a *new* name that you've created in the element = a new exposure.

### 3.3 Enumerating drawings + their frames
```javascript
// All drawing names that exist in the element behind this column:
var timings = column.getDrawingTimings(columnName); // StringList e.g. ["1","2","note_a"]

// First frame where a given drawing appears on the timeline:
function firstFrameOfDrawing(columnName, drawingName) {
  var n = frame.numberOf();
  for (var f = 1; f <= n; f++) {
    if (column.getEntry(columnName, 1, f) == drawingName) return f;
  }
  return -1; // not currently exposed anywhere
}
```
- `frame.numberOf()` → total frames; `frame.current()` → playhead; `frame.setCurrent(f)` → move playhead (used when a note is clicked).
- **"What frame it first appears at"** (your UI requirement) = `firstFrameOfDrawing()` above. Note a drawing may appear on multiple ranges; we report the earliest.

### 3.4 Creating an actual drawing to expose
Exposing a name only works if a drawing by that name exists in the element. Create one with:
```javascript
Drawing.create(elementId, drawingName, /*bool*/ true); // create empty drawing "drawingName"
```
- `Drawing.create(int elementId, String drawingName, bool fileExists)` **[verify arg order in app]** — some versions add a `storeInProjectFolder` bool.

### 3.5 SyncNote's "add a note point" flow (substitution creation)
When the user runs the script and the playhead is at frame F:
1. Ensure the Notes element/column/READ node exist (§4, §5).
2. Pick a new unique drawing name (e.g. next integer not in `getDrawingTimings`).
3. `Drawing.create(elementId, name, true)`.
4. `column.setEntry(notesColumn, 1, F, name)` → the substitution now lives at frame F.
5. Notes for that name are stored/loaded by element ID + name (§6).

---

## 4. Elements and element IDs (create + read)

### 4.1 Reading the element ID behind a column
```javascript
var elementId = column.getElementIdOfDrawing(columnName); // -> int
```

### 4.2 Element ID from node (via its column)
```javascript
var col = node.linkedColumn(readNodePath, "DRAWING.ELEMENT"); // column name, "" if none
var elementId = column.getElementIdOfDrawing(col);
```

### 4.3 Creating a new element
```javascript
// element.add(name, scanType, fieldChart, fileFormat, vectorFormat) -> elementId (-1 on failure)
var elementId = element.add("Notes", "COLOR", 12, "SCAN", "TVG");
```
- Returns the new **integer element ID**, or `-1` on failure.
- `fileFormat`/`vectorFormat` `"SCAN"`/`"TVG"` create a standard vector element. **[verify: some versions use "" for fileFormat with vector "TVG"]**

### 4.4 Element info helpers
| Call | Returns |
|---|---|
| `element.numberOf()` | count of elements in scene |
| `element.id(index)` | element ID at index `0..numberOf-1` |
| `element.getNameById(id)` | current element name |
| `element.physicalName(id)` | on-disk drawings folder name |
| `element.renameById(id, name)` | rename (id stays the same) |

**Why element ID, not READ name (your question):** the READ node name and the element *name* are both mutable and non-unique; the element **ID** is the DB key and unique. Keying SyncNote data on the ID means renames never orphan notes. ✅

---

## 5. Creating & linking the Notes READ node

Canonical create-and-link sequence (wrap in undo accum):
```javascript
// 1. element (physical drawings)
var elementId = element.add("Notes", "COLOR", 12, "SCAN", "TVG");

// 2. drawing column (exposure track)
var colName = "Notes";
column.add(colName, "DRAWING");

// 3. bind the column to the element by ID
column.setElementIdOfDrawing(colName, elementId);   // [verify name; pairs with getElementIdOfDrawing]

// 4. READ node (visible layer) under the scene root/group
var readNode = node.add("Top", "Notes", "READ", 0, 0, 0); // (parent, name, type, x, y, z)

// 5. link node's exposure attribute to the column
node.linkAttr(readNode, "DRAWING.ELEMENT", colName);      // [verify: some code uses node.linkColumn]
```

### 5.1 Finding an existing Notes layer (re-use, don't duplicate)
Your requirement: *if a scene already has a notes layer, re-use it and load its notes.* Detection strategy, in priority order:
1. **By stored element ID** — SyncNote records "the SyncNote element ID" in scene metadata (§6). On launch, if that ID still exists (`element.getNameById(id) != ""`), re-use it. Most robust.
2. **Fallback by name** — scan `node.getNodes(["READ"])` for a node named `Notes` (or a marker); resolve its column → element ID; adopt it.

Only if neither is found do we create a new one.

---

## 6. Data storage (where notes actually live)

Notes must persist **inside the Harmony scene** and survive renames. Options evaluated:

| Option | Persists in scene? | Survives rename? | Size limit | Verdict |
|---|---|---|---|---|
| **Scene metadata** (`scene.setMetadata`) | ✅ saved in `.xstage` | ✅ (key by element ID) | large strings OK | ✅ **Chosen** |
| Node metadata (`node.metadata`) | ✅ | ⚠️ tied to node, lost if node deleted | ok | backup only |
| External JSON next to scene | ✅ on disk | ✅ | unlimited | breaks if scene moved/copied |
| Drawing file contents | ✅ | ✅ | awkward | no |

### 6.1 Scene metadata API (JS)
```javascript
// WRITE — value must be a primitive; we store JSON as a string
scene.setMetadata({
  name:    "SyncNote",      // our key
  type:    "string",         // string | int | double | bool
  creator: "SyncNote",
  version: "1.0",
  value:   JSON.stringify(dataObject)
});

// READ
var meta = scene.metadata("SyncNote", "string"); // -> object or null/empty
var data = (meta && meta.value) ? JSON.parse(meta.value) : defaultData();

// LIST / REMOVE
var all = scene.metadatas();
scene.removeMetadata({ name: "SyncNote", type: "string" });
```
- Metadata is a **key/value store persisted with the scene** ("saved and loaded with the project"). Values are primitives, so we serialize our whole model to a JSON string. **[verify: confirm large JSON strings round-trip; if a length cap exists, fall back to node.metadata or chunked keys.]**

### 6.2 SyncNote data schema (v1)
```jsonc
{
  "version": 1,
  "syncNoteElementId": 42,          // which element is the Notes layer (for re-use/detection)
  "notesByDrawing": {
    "42": {                          // keyed by element ID (string)
      "note_a": [                    // keyed by drawing name within that element
        {
          "id": "n_1719800000000",   // unique note id (timestamp-based)
          "text": "Robot should move 1.5s earlier.",
          "date": "2026-07-01T16:40:00Z",
          "author": "zackz"          // optional; from about/user or left blank
        }
      ]
    }
  }
}
```
- Keying by **elementId → drawingName → [notes]** is what makes renames safe.
- The **frame a note appears at is *not* stored** — it's derived live from `firstFrameOfDrawing()` so it stays correct if exposure is moved. (Store only if you want a snapshot.)

---

## 7. Building the resizable, scrollable Qt dialog

The built-in `Dialog` class (LineEdit/Label/Button/etc.) is quick but **cannot do a resizable, scrolling, dynamically-populated list** like SyncSketch. For that we use **native Qt widgets**, which Harmony's Qt Script exposes globally.

### 7.1 Core widgets available
`QWidget`, `QDialog`, `QVBoxLayout`, `QHBoxLayout`, `QScrollArea`, `QLabel`, `QPushButton`, `QTextEdit`/`QPlainTextEdit`, `QLineEdit`, `QListWidget`, `QFrame`, `QSize`. Plus `UiLoader` for loading `.ui` files made in Qt Designer.

### 7.2 Two ways to lay it out
**A. Code-built (recommended to start)** — full control, no external file:
```javascript
var dlg = new QDialog();
dlg.setWindowTitle("SyncNote");
dlg.setMinimumSize(360, 480);           // resizable: user can drag larger
var outer = new QVBoxLayout(dlg);

// scroll area that grows/shrinks with the window
var scroll = new QScrollArea();
scroll.widgetResizable = true;           // key: content resizes to avoid needless scrollbars
var listHost = new QWidget();
var listLayout = new QVBoxLayout(listHost);
scroll.setWidget(listHost);
outer.addWidget(scroll, 1);              // stretch=1 so it takes extra vertical space

// footer buttons
var footer = new QHBoxLayout();
var addBtn = new QPushButton("Add Note");
footer.addWidget(addBtn);
outer.addLayout(footer);
```
- `scroll.widgetResizable = true` (Qt's `setWidgetResizable(true)`) is the property that makes the inner content track the window size — this is the "resizable + scrollable" combo you want.
- Add note rows to `listLayout` dynamically; append a stretch at the end (`listLayout.addStretch(1)`) so rows pack to the top like the screenshot.

**B. Qt Designer `.ui` + UiLoader** — for a polished layout later:
```javascript
var ui = UiLoader.load(specialFolders.userScripts + "/SyncNote/SyncNote.ui");
ui.someButton.clicked.connect(onAdd);   // children accessed by objectName
ui.show();
```

### 7.3 A note "card" (matches your screenshot: date + drawing/frame + text + delete)
```javascript
function makeNoteCard(note, drawingName, frameNo) {
  var card = new QFrame();
  card.frameShape = QFrame.StyledPanel;
  var v = new QVBoxLayout(card);

  var header = new QLabel("Frame " + frameNo + "  •  drawing " + drawingName
                          + "   " + relativeDate(note.date));  // e.g. "15 days ago"
  var body   = new QLabel(note.text);
  body.wordWrap = true;
  var del     = new QPushButton("Delete");

  v.addWidget(header);
  v.addWidget(body);
  v.addWidget(del);

  // clicking the card jumps the playhead to the drawing's first frame:
  card.mouseReleaseEvent = function(){ frame.setCurrent(frameNo); };
  del.clicked.connect(function(){ deleteNote(note.id); refresh(); });
  return card;
}
```
> The green "Frame 0049" text in your screenshot maps to our `header` line (frame + drawing). Names/avatars are intentionally omitted per your spec; **date is kept** and rendered relative.

### 7.3.5 ⚠️ Qt binding gotchas (learned from live testing, Harmony Premium)
These caused real crashes in v1 **and v2** — treat as hard rules:

1. **`QBoxLayout.addWidget` requires exactly 3 args with a real `Qt.Alignment`:** the binding exposes *only* `addWidget(QWidget, int stretch, Alignment)`. Both `layout.addWidget(w)` (1-arg from `QLayout` — hidden by the subclass binding; this is what crashed v2) and `layout.addWidget(w, 1, 0)` (int is not converted to `Alignment`; this is what crashed v1) throw *"could not find a function match"*.
   **Evidence from working code on-disk:** openHarmony always calls `layout.addWidget(button, 0, Qt.AlignHCenter)` — 3 args, real enum — and constructs flags objects like `new Qt.WindowFlags(Qt.Popup|…)`, proving the `new Qt.<FlagsType>(int)` constructor pattern works in Harmony's bindings.
   **Rule: route every add through a fallback helper** that tries, in order: `addWidget(w, stretch, new Qt.Alignment(0))` ("no alignment" → widget fills its cell), then `addWidget(w, stretch, 0)`, then `addWidget(w)` — caching whichever form the current engine accepts. (See `addW()` in SyncNote.js.)
2. **Don't rely on `addLayout()` for nesting.** Wrap each sub-layout in a container `QWidget` (`var row = new QWidget(); var h = new QHBoxLayout(row); ... addW(outer, row);`).
3. **Prefer an expanding spacer widget over `addStretch()`:** `addW(layout, new QWidget(), 1)` achieves the same packing with none of `addStretch`'s own overload risk. (`QScrollArea`'s Expanding size policy also naturally absorbs extra space next to fixed-height buttons.)
3b. **Research trick:** a Harmony install usually has working community scripts on disk (`%APPDATA%/Toon Boom Animation/**` — openHarmony, downloaded tool scripts). **Grep those for the API you're unsure about** — proof from the same binding beats docs or forum guesses.
4. **Overriding virtuals like `widget.mouseReleaseEvent = fn` is unreliable** in Harmony's Qt Script. For clickable text use a `QLabel` with an HTML `<a href="#">` and connect its **`linkActivated`** signal — works everywhere and doubles as SyncSketch-style green link styling.
5. **Set sizes via properties** (`dlg.minimumWidth = 380`) rather than `setMinimumSize(w, h)` — avoids `QSize` overload-matching issues.
6. **A script error aborts the whole run** — Harmony shows a Retry/Abort box and the UI never appears. Wrap `main()` in try/catch and report via `MessageBox.information` (the `warning` variant renders with Retry/Abort buttons, which confuses users).
7. **`new Date(isoString)` returns Invalid Date** in Harmony's JS engine (renders as "NaN-NaN-NaN"). Store numeric timestamps (`(new Date()).getTime()`) and construct with `new Date(number)`; hand-parse ISO strings from legacy data with a regex + `Date.UTC(...)`.
8. **Composite port order vs. render order: do NOT trust port indices or the docs — measure.** The user docs say "the leftmost port renders in front", but live measurement (v0.9.0 logs) proved the opposite for API port order: **the LAST-connected input (highest port index) is the frontmost layer**; port/index 0 renders at the back. Every fix that targeted "port 0 = front" was therefore inverted, while the API happily reported success. Compounding it: `node.link(src, 0, comp, dstPort, false, true)` does not insert at `dstPort` — when occupied, `mayAddInputPort` appends a new port at the end. Rules that survived testing:
   - The only reliable check is the **actual render order**: `compositionOrder.buildDefaultCompositionOrder()` returns the Timeline's composition, frontmost node first (see `renderRank()`).
   - To reposition a node, **rebuild the whole port order** (snapshot inputs via `node.srcNodeInfo`, unlink all high→low, relink in the desired sequence — connection order determines stacking, last = front) in one undo accum.
   - After any rewiring, **re-measure and only report what the measurement confirms**; try the opposite order as a fallback rather than assuming semantics (see `connectNotesNode()`).
9. **Scene metadata persists only when the scene is saved.** `scene.setMetadata` updates the in-memory scene; the data reaches the `.xstage` on scene save. Unsaved session = unsaved notes.
10. **Script-side QObject overrides die silently when their JS wrapper is garbage-collected.** A `new QObject()` with an assigned `eventFilter` (or any overridden virtual) works only while the script wrapper object is alive; once GC collects it, the C++ object keeps existing but the override reverts to a no-op — no error, the behavior just stops. Symptom in the wild: card clicks dying *intermittently, per-card*, after some interaction. **Fix: pin every such object in a module-level keep-alive array** (`g_snKeepAlive.push(f)`), reset per launch/refresh. Signal connections don't need this (the engine holds connection closures); virtual overrides and property-assigned handlers do.

### 7.4 Signals / slots
```javascript
button.clicked.connect(function(){ /* handler */ });
// or bind context: button.clicked.connect(this, this.onAdd);
```

### 7.5 Non-modal window + garbage collection (critical gotcha)
- Show non-modally so the artist can keep working: `dlg.show();` (not `dlg.exec()`).
- **Danger:** if the only reference to the dialog is a local `var`, Qt Script may garbage-collect it and the window vanishes. **Keep a reference alive** — store it on a persistent global/module object:
```javascript
// module-level (survives because the script module stays loaded)
SyncNote.prototype.dlg = dlg;    // or: this.dlg = dlg;  / a global var
```
- Optionally set delete-on-close if you *do* want teardown: `dlg.setAttribute(Qt.WA_DeleteOnClose, true);` — but then also clear your saved reference.

### 7.6 Clicking a note → go to frame
Your interaction ("click a note → jump to the frame where the drawing first appears") is `frame.setCurrent(firstFrameOfDrawing(col, drawingName))`, wired in §7.3. Because SyncNote also created the substitution, jumping there shows both the note *and* the drawing on canvas. ✅

---

## 8. Putting it together — SyncNote runtime flow

```
Launch SyncNote
  ├─ Load model from scene metadata "SyncNote" (or default)
  ├─ Resolve Notes layer:
  │     stored elementId valid? ── yes ──> reuse (adopt its column/node)
  │            └ no ──> scan for READ named "Notes" ── found ──> adopt
  │                          └ not found ──> create element+column+READ, save elementId
  ├─ Build/refresh dialog:
  │     for each drawingName in getDrawingTimings(notesColumn):
  │        frameNo = firstFrameOfDrawing(notesColumn, drawingName)
  │        render note cards for notesByDrawing[elementId][drawingName]
  └─ Show non-modal, keep reference

"Add Note" button:
  ├─ F = frame.current()
  ├─ if no substitution at F: create drawing + setEntry(col,1,F,newName)
  ├─ append {id,text,date,author} to notesByDrawing[elementId][drawingName]
  ├─ scene.setMetadata(JSON.stringify(model))
  └─ refresh list

Click a note card:  frame.setCurrent(frameNo)
Delete a note:      splice from model -> setMetadata -> refresh
```

### 8.1 Verification status (post-research)
- [x] `Drawing.create(int elementId, String timing, bool fileExists, bool storeInProjectFolder=false)` → bool — **confirmed** in docs.
- [x] `node.linkAttr(String node, String attrName, String columnName)` → bool — **confirmed**; we use `"DRAWING.ELEMENT"`.
- [x] `node.add(parent, name, "READ", x, y, z)` → node path — **confirmed**.
- [x] `column.setElementIdOfDrawing` — **confirmed** to exist (pairs with the getter). Argument order `(columnName, elementId)` — smoke-test once.
- [ ] Practical size cap on a single `scene.setMetadata` string value — untested. Fallback if hit: chunk into `SyncNote_0`, `SyncNote_1`, … keys, or move to `node.metadata`.
- [ ] `card.mouseReleaseEvent = fn` note-card click binding — works in Harmony's Qt Script but confirm in target version; each group also has an explicit "▶ Go to frame" button as a guaranteed fallback.

### Target: Harmony **22 and 24/25 Premium**
Code is written version-tolerant against the intersection of those APIs (all calls above exist in 22→25). No Essentials assumptions.

---

## 9. Implementation log — `SyncNote.js` v1

Built the full script. Key decisions as implemented:

- **State kept at module scope** (`g_snDialog`, `g_snLayer`, `g_snModel`). Top-level vars persist while the script module is loaded — this is what keeps the non-modal `QDialog` alive (Qt GC) and lets a second launch just re-raise the existing window instead of duplicating.
- **Layer detection** (`snFindNotesLayer`): scan `node.getNodes(["READ"])`; match first by stored `syncNoteElementId` (via `column.getElementIdOfDrawing`), then fall back to a READ node named `Notes`. Create only if neither found (`snCreateNotesLayer`, wrapped in one undo accum).
- **Substitution creation** (`snEnsureSubstitutionAtFrame`): if a drawing is already exposed at the playhead, reuse it; else pick the next integer name, `Drawing.create`, `column.setEntry`.
- **Frame is derived, not stored** (`snFirstFrameOfDrawing` scans the column) so "first frame" stays correct when exposure moves.
- **Storage**: whole model JSON-serialized into one scene-metadata key `SyncNote` (`snLoadModel`/`snSaveModel`). Keyed `elementId → drawingName → [ {id, text, date} ]`.
- **UI**: `QDialog` + `QVBoxLayout`; a `QScrollArea` with `widgetResizable = true` holding a `QGroupBox` per substitution (frame/drawing header, "Go to frame" button, note cards, inline "Add a note…" field). Toolbar has "Add Note @ Frame N" + "Refresh". Closures in loops are captured via IIFE factories (ES5 — no block scoping).
- **Author/name intentionally omitted** from the UI per spec; only the (relative) **date** is shown. Field left out of the model to keep it lean.

### 9.1 Install & test
1. Copy `SyncNote.js` to the user scripts folder (`specialFolders.userScripts`).
2. In Harmony: **Script Editor** → run `SyncNote()` once to smoke-test, or add a **toolbar button** (Scripts → Manage Toolbar) bound to `SyncNote`.
3. First run creates a `Notes` layer + opens the panel. Move the playhead, click **Add Note @ Frame**, type notes, click a card to jump frames. Save the scene, reopen — notes should reload from metadata.
4. If the note-card click doesn't navigate in your version, use the per-group **▶ Go to frame** button (always works) and tell me — I'll switch cards to a flat clickable button.

---

## 10. Implementation log — v2 (fixes from first live test)

First in-app run surfaced four issues; all fixed:

1. **Function-picker clutter** — v1 had ~20 top-level functions, all of which appear in Harmony's script/toolbar function picker. **Fix:** everything is now nested inside a single `function SyncNote()`; the picker shows exactly one entry. Persistent-state top-level `var`s were dropped too (see #4 for why they were unreliable anyway).
2. **Orphan READ node** — creating element+column+READ leaves the node unconnected, so it never renders. **Fix:** `attachToComposite()` finds the top-level Composite (`node.getNodes(["COMPOSITE"])`, preferring a path directly under `Top`) and calls `node.link(read, 0, comp, 0, false, true)`. Port 0 with `mayAddInputPort=true` inserts at the **leftmost** input, which the Composite renders **on top** — correct for review notes. Falls back to the 4-arg `link` if the 6-arg overload is missing; also runs for adopted pre-existing layers that are unwired.
3. **`QBoxLayout::addWidget` crash** (the Retry/Abort error box) — root cause and rules documented in §7.3.5. UI rebuilt using only single-arg `addWidget` + container widgets. This crash was also why **no popup ever appeared**: the exception aborted the script before `dlg.show()`.
4. **Dialog lifetime / duplicates** — toolbar runs may re-evaluate the file in a fresh script engine, so module-level `var g_snDialog` can't be trusted to spot an already-open panel, and an old panel's signal connections can go dead. **Fix:** the dialog gets `objectName = "SyncNoteDialog"`; on launch we scan `QApplication.topLevelWidgets()`, close any existing panel, and build a fresh one (relaunching ≈ refresh). The dialog is parented to Harmony's `QMainWindow` so Qt owns its lifetime (no script-GC vanishing).

UX changes in v2:
- "Add Note @ Frame N" now only creates the substitution + group; you type the note in the group's own **Add a note…** field (Enter submits). No more placeholder note text.
- Frame navigation is a green **`Frame ####`** link per group and a small **▶ Frame ####** link on each note card (QLabel `linkActivated` — reliable across versions), replacing the `mouseReleaseEvent` hack.

---

## 11. Implementation log — v3 (the addWidget saga, resolved)

v2 still crashed with the same `QBoxLayout::addWidget` error — the v2 "fix" (single-arg calls) was wrong, because the 1-arg overload is *also* hidden by the binding. The real rule (§7.3.5 #1, corrected): **exactly 3 args, third must be a genuine `Qt.Alignment` object.**

How it was diagnosed: instead of guessing, we grepped *working* scripts already on this machine —
- openHarmony (`%APPDATA%/Toon Boom Animation/openHarmony/**`): every call is `layout.addWidget(w, 0, Qt.AlignHCenter)`-style, and flags objects are built with `new Qt.WindowFlags(...)`.
- This gives both the required call shape and proof that `new Qt.<FlagsType>(int)` constructors exist in Harmony's engine.

Fix in SyncNote.js: all adds now go through **`addW(layout, widget, stretch)`**, which tries `(w, stretch, new Qt.Alignment(0))` → `(w, stretch, 0)` → `(w)` and caches the first form that works, so the same file runs on Harmony 22 and 24/25 engines regardless of which conversion rules each enforces. `addStretch(1)` was replaced by an expanding spacer widget through the same helper.

Also fixed: v2's misstatement in §10 item 3 ("single-arg addWidget works") — superseded by this entry.

---

## 12. Implementation log — v4 (brief-compliance pass)

After the first fully-running build, a re-read of the brief against the behavior surfaced one true misread and one visibility problem:

1. **Misread — substitution on run.** Brief: *"When you run the script, it creates a brand new drawing called Notes, **and creates a drawing substitution wherever the timeline playhead is**."* v3 only created subs from the "Add Note @ Frame" button. Fixed: `main()` now calls `ensureSubstitutionAtFrame(layer, frame.current())` on every launch.
2. **Substitution semantics.** `ensureSubstitutionAtFrame` used to reuse a drawing if the frame was anywhere inside its exposure. Corrected to reuse **only when a sub starts exactly at that frame** — a mid-exposure playhead now splits the exposure with a new sub (the SyncSketch "annotate this moment" flow). Detection: `getEntry(F) !== getEntry(F-1)`.
3. **"No node created" report.** The creation code was unchanged since the version that visibly created nodes, so the suspect is stale scene state from crashed test runs (`scene.setMetadata` is **not undoable**, and deleting a READ node leaves its element + column + notes in the scene). Hardening added:
   - **Recovery path**: if metadata's element ID resolves to a surviving column but no READ node, rebuild just the node (`findColumnByElementId` + `createReadNodeFor`) instead of orphaning old notes with a fresh element.
   - **Unique node names** (`uniqueNodeName`) — `node.add` returns `""` on a name collision, e.g. a leftover "Notes" node.
   - **Post-create verification**: `node.type(readPath) === "READ"` or throw.
   - **Composite attach is now verified and reported**, returning a status string ("connected to Composite" / "NOT connected — plug the Notes node into your Composite"), with a 4-arg `node.link` fallback to a fresh port (`numberOfInputPorts`) if the 6-arg overload is refused by the binding.
   - **Status bar** at the bottom of the panel: `Layer: Top/Notes • element #N • connected…` — the panel now states exactly what it's bound to, ending silent-failure debugging.
   - **`revealLayer()`**: selects the Notes node on launch so it's highlighted in the Timeline/Node View.

Testing note for scenes used with older builds: stale `SyncNote` metadata + leftover "Notes" elements/columns can linger. The recovery path adopts them cleanly now, but a pristine test is easiest in a fresh scene.

---

## 13. Implementation log — v5 (first fully-working build + polish)

v4 passed live testing end-to-end in a fresh scene: layer + sub created on run, subs added per playhead, notes persist across panel close/reopen **and** full Harmony restarts, auto-reattach after manual detach confirmed working. Two issues fixed from that test:

1. **"NaN-NaN-NaN" dates** — Harmony's JS engine can't parse ISO-8601 strings via `new Date(iso)` (§7.3.5 #7). Notes now carry a numeric `ts` field; `noteTime()` falls back to regex-parsing the ISO `date` string for notes saved by older builds, so existing test notes display correctly too.
2. **Notes rendered behind the artwork** — the composite connection landed on the rightmost port (back). Per §7.3.5 #8, `ensureFrontPort()` now finds which input port the Notes node actually occupies and re-seats it to port 0 (leftmost = front) on every launch, with safe restore if the engine refuses the insert. The status bar reports "(in front)" vs. an instruction to move the cable manually.

Data-storage recap (user question): the whole notes model is one JSON string in scene metadata under key `"SyncNote"` — written on every add/delete via `scene.setMetadata`, persisted into the `.xstage` when the scene is saved, keyed `elementId → drawingName → [notes]` so renames never orphan anything (§6).

---

## 14. Implementation log — v6 (front-port fix, for real this time)

v5's `ensureFrontPort` made things worse: it unlinked the Notes cable and "re-inserted at port 0" — but `mayAddInputPort` **appends at the right end** when the target port is occupied (§7.3.5 #8, updated). Net effect: every run dragged the cable back to the rightmost port, even undoing the user's manual leftmost placement.

v6 replaces it with `bringToFrontOfComposite()`:
- Snapshot all composite inputs in port order (preserving each source's output port via `srcNodeInfo`).
- If Notes is already port 0 → do nothing (manual placement is respected).
- Otherwise unlink every port (high→low) and relink **Notes first**, then the rest in their original order — ports fill left→right in connection order, so Notes lands leftmost = front.
- Whole reorder is one undo step; verified afterwards via `node.srcNode(comp, 0)`.

Known trade-off: rebuilding connections drops any waypoints on those cables (cosmetic).

**Status after live test: still lands at the back — backburnered.** v0.6.1 was confirmed running (version stamp in title) and the reorder still didn't stick. All API calls verified against official docs (they exist as used; leftmost-port-renders-front also confirmed in the Composite node docs), so the failure is behavioral, not a hallucinated function. `logPortMap()` now dumps the composite's `port index → source node` map to the Message Log on every run, so real data is waiting whenever this is picked back up.

---

## 15. Implementation log — v0.7.0 (UI revision: frames first)

User-driven redesign — for students reviewing shots, *where in time* a note sits is the identity of a group, not the drawing number:

1. **Group header = clickable frame number.** The `drawing 1` box title is gone; each group is a plain framed card whose first row is a bold green `Frame 009` link (jump on click). Padding adapts to scene length via `padFrame()`: digits = `String(frame.numberOf()).length` (60 frames → `Frame 09`, 300 → `Frame 009`). Non-exposed subs show a gray non-clickable header.
2. **Separate green frame-link row removed** — merged into the header.
3. **Note meta line** is now `21 minutes ago  •  Sub 1` ("Sub N" = the substitution number, capital S per user). Per-card frame links removed; navigation lives on the header.
4. **Multiline, auto-growing note input.** `QLineEdit` → `QTextEdit`: text wraps, and `sizeNoteInput()` grows the box with the document height (cap ~8 lines, then internal scroll), falling back to a fixed 2-line height if document metrics aren't bound in the engine.
   **Enter = save, Shift+Enter = newline** (Discord-style), implemented in two layers because key interception is unproven in these bindings (no precedent found in openHarmony):
   - Primary: a `QObject`-based event filter (`makeEnterFilter`) whose script-side `eventFilter` override consumes plain Enter and commits (classic Qt Script Generator bindings support JS overrides of QObject virtuals).
   - Fallback: if the filter is inert, the Enter lands as a trailing `"\n"` — the `textChanged` handler detects it, checks Shift via `QApplication.keyboardModifiers()`, and commits (trimming the newline). Worst case both layers fail silently → the Add button still commits.
5. **Toolbar simplified** to a single static **Add Note** button (the frame number in the label was stale between refreshes); Refresh button removed — the list already re-renders on every add/delete and on relaunch.

Also: `logPortMap()` diagnostics (see §14 status note) and version bump shown in the title bar.

---

## 16. Implementation log — v0.7.1 (scroll preservation + clickable Subs)

1. **Scroll no longer jumps on add/delete.** `refresh()` rebuilds the whole list, which resets `QScrollArea`'s position. Now the scrollbar value is captured before the rebuild and restored twice: immediately, and again via a parented single-shot `QTimer` at 50 ms — the immediate restore can be clamped because the rebuilt content hasn't been measured yet. (Timer pattern lifted from openHarmony's toast implementation — proven on this engine.)
2. **"Sub N" on note cards is now a clickable link** that jumps to the sub's first frame, same as the group header (gray/non-clickable when the sub isn't exposed).
3. Accepted caveat (user decision): notes persist to disk only when the Harmony scene is saved (§7.3.5 #9); auto-saving the scene on panel close was considered and rejected as intrusive.

---

## 17. Implementation log — v0.8.0 (clickable cards, copyable text, frame scrubbing)

1. **Click a note card's background → jump to its frame.** Implemented with a mouse `eventFilter` (`makeClickFilter`) on the card frame — the same QObject-filter mechanism the Enter key uses, which live testing confirmed works on this engine. The filter only observes (`return false`), so children that accept their own mouse events never bubble up to it: links, the ✕ button, the input box, and the now-selectable text all keep working. Clicks on genuinely empty card space propagate to the card and trigger the jump.
2. **Note text is selectable/copyable** via `textLbl.textInteractionFlags = Qt.TextSelectableByMouse` (drag-select, Ctrl+C, right-click Copy) — defensively wrapped; if a binding refuses the enum property the text simply stays non-selectable. Selection and card-click coexist *because* of the propagation rule in #1: a label that accepts mouse events swallows them.
3. **Frame scrub buttons** — toolbar is now `[ Add Note ][◀][▶]`. `scrubToNoteFrame(dir)` jumps the playhead to the nearest note frame strictly after (▶) or before (◀) the *live* playhead position; frames are recomputed from `collectGroups` on every click so new subs are always included. No wrap-around at the ends.

---

## 18. Implementation log — v0.8.1 (one click model: the card IS the button)

v0.8.0 live test: scrubbing ✓, text copy ✓, but card-background clicks were dead. Two suspects fixed together (user's call: simplify rather than diagnose):

1. **All `<a href>` links removed** — the green frame header and "Sub N" are plain text now. Rationale: a QLabel with links accepts mouse events, so it swallows clicks instead of propagating them to the card; with the card as the sole click target there is nothing left to compete with. Navigation = click anywhere on the **group card** (header area, note cards, background) + the scrub buttons.
2. **Click filter moved to the group card and hardened** (`makeClickFilter`): the event Harmony passes a filter may be a generic `QEvent` with no `button()`, and the `QEvent` enum itself may be unbound — either would throw and my catch silently killed every click in v0.8.0. Now: numeric fallback for the type id (`MouseButtonRelease == 3`), and the left-button check is optional instead of fatal.
3. Text selection still works and still doesn't jump — a selectable label accepts its mouse events, so they never bubble to the card filter.

Rollback point if card clicks are still dead on some engine: `git checkout b8b68a9 -- SyncNote.js` restores the v0.8.0 link-based navigation.

---

## 19. Implementation log — v0.8.2 (intermittent click death = GC)

v0.8.1 live test: card clicks worked but died *intermittently, per-card* after clicking around — the fingerprint of garbage collection, not logic. Root cause (§7.3.5 #10): each card's click filter is a `new QObject()` whose `eventFilter` override lives on the JS wrapper; nothing held a reference to the wrapper, so GC collected some of them mid-session and those filters silently reverted to no-ops.

Fix: module-level `g_snKeepAlive` array pins every script-created QObject — click filters, Enter filters, and the scroll-restore timer — for the panel's lifetime. Reset on each launch and on each list rebuild (old cards are torn down anyway). Same class of bug as the "keep the dialog referenced" rule from §7.5, now generalized: **anything with a script-side override must be pinned.**

Rollback (if still flaky): `git checkout b8b68a9 -- SyncNote.js` for v0.8.0 link navigation + selectable text.

---

## 20. Implementation log — v0.8.3 (back to links, by choice)

The GC pin (v0.8.2) **did fix** the dying clicks — confirmed in live testing. The user still chose to roll navigation back to links: even working, card-wide click filters *feel* unreliable, and links are handled natively by QLabel with zero GC/propagation caveats. Design lesson worth keeping: **prefer `linkActivated` links over event-filter click targets in Harmony UIs** — filters are for the cases links can't cover (keys in a QTextEdit).

v0.8.3 = v0.8.0's navigation (green clickable `Frame 009` header + `Sub N` links) combined with everything learned since:
- selectable/copyable note text (kept),
- GC keep-alive pinning (kept — the Enter filters still need it),
- scroll preservation and scrub buttons (kept),
- the card-wide click filter (`makeClickFilter`) removed entirely.

---

## 21. Implementation log — v0.9.0 (connection redone: verify by render order)

The composite-cable saga's root flaw, finally named (with the user's help — "it's just the layer stack"): every attempt verified success by **port index** and the docs' "leftmost port renders front" claim, then argued with what the user saw in the layer stack. v0.9.0 stops inferring and **measures the render order directly**:

- **`compositionOrder.buildDefaultCompositionOrder()`** (never used before; found via the class index) returns the actual composition — *"the Timeline view's composition order"* — frontmost node first. This is the oracle.
- **`renderRank(readPath)`**: counts how many READ nodes render in front of Notes (0 = frontmost drawing layer; effects/pegs don't count; `-2` = unmeasurable).
- **`connectNotesNode()`** replaces `attachToComposite` + `bringToFrontOfComposite`: ensure linked → measure → if not frontmost, reorder with **Notes first**, re-measure → if still not, reorder with **Notes last** (covers the reversed port-semantics case), re-measure → report only what the measurement confirms. Status bar shows "frontmost layer ✓ (which strategy)" or "renders BEHIND N layer(s) — diagnostics in Message Log".
- On failure, `logCompositionOrder()` + `logPortMap()` dump everything needed to the Message Log — if neither port order changes the rank, the reordered composite is not the one deciding stacking in that scene (nested composites), and the dump will show which node is.
- All rewiring remains one undo step; each step traced via `trace()`.

Design lesson for §7.3.5: **when the API and the user's eyes disagree, find the API that measures what the user is actually looking at.**

**RESOLVED (v0.9.1, 2026-07-02).** *(see §22 for the follow-on auto-refresh work)* Live test confirmed all behaviors: wrong port → auto-moved to front; detached → reconnected to front; already front → untouched. The logs settled the mystery: `after reorder (Notes on first port): rank 39` / `after reorder (Notes on last port): rank 0` — **the last-connected port is the frontmost layer**, the inverse of the documented claim (§7.3.5 #8 updated). v0.9.1 tries the proven winner first to avoid a wasted rewire, keeping Notes-first as a safety net for other scenes/versions.

---

## 22. Implementation log — v0.10.0 (stale-frame fix: auto-refresh + click self-heal)

Oversight found in testing: the panel snapshots each sub's first frame at build time, so dragging a sub to another timeline frame while the panel is open left dead links (click → old frame). Fixed with two independent layers:

1. **Click-time self-heal (correctness backbone).** `makeJump(frameNo)` → `makeJumpToSub(drawingName, shownFrame)`: the sub's first frame is **recomputed at click time** via `firstFrameOfDrawing`, so navigation is always correct regardless of display staleness; if the recomputed frame differs from what the card shows, the click also triggers a refresh. (The scrub buttons already recomputed live — that's why they never had the bug.)
2. **Event-driven auto-refresh.** A `SceneChangeNotifier(dlg)` (first use in this project) listens to `columnValuesChanged(StringList)`; when the list contains our notes column (case-insensitive; treat-as-relevant when uninspectable), a 300 ms debounced single-shot timer compares a `drawing:frame` **signature** of the live timeline against what's displayed and rebuilds only on a real difference. This makes our own writes (which already refresh) and unrelated edits no-ops. Constructor pattern from the docs: `new SceneChangeNotifier(parentQObject)`; parenting to the dialog ends notifications when the panel closes.

Supporting changes:
- **Keep-alive split**: `g_snKeepAlive` (per-refresh: card filters, scroll timer) vs. new `g_snKeepAlivePanel` (panel-lifetime: notifier, stale timer) — the notifier must survive list rebuilds, and the per-refresh array is cleared on every rebuild (§7.3.5 #10 applies to the notifier too).
- **Draft preservation**: before any rebuild, non-empty input texts are stashed per drawing and restored into the rebuilt boxes, so an auto-refresh can never eat a half-typed note; `commit()` empties its box pre-refresh so committed text isn't re-saved as a draft.
- If `SceneChangeNotifier` is unavailable on an engine, it degrades to click-time self-heal only (traced to the Message Log).

### v0.10.1 — auto-refresh un-filtered
Live test of v0.10.0: notifier constructed ("active" trace) but a sub drag produced no refresh and no trace — the handler either never fired or was killed by the **column-name filter** (the signal likely carries internal column names that don't match the created name). Fix:
- **Filter removed** — every `columnValuesChanged` schedules the (free-when-not-stale) signature check; the comparison is the gatekeeper, not the event source.
- **Broader subscription** — `sceneChanged()` and `currentFrameChanged()` also feed the same debounced check; `currentFrameChanged` guarantees the panel reconciles on the next playhead touch even if an edit emits nothing else we know about.
- **Diagnostics** — first `columnValuesChanged` logs the column names it carries (settles the internal-name question), and the auto-refresh trace names which signal triggered it.
- **Confirmed working in live test**: sub drags auto-refresh the header within ~a second; the triggering signal on Harmony 22 was `currentFrameChanged` (the belt-and-suspenders subscription), not `columnValuesChanged`.

---

## 23. Implementation log — v0.11.0 (navigation that follows you)

Two QoL fixes for long timelines (e.g. a note at frame 900 of 1000 while zoomed in):

1. **Panel follows the scrub buttons.** `liveGroups` maps `drawing → group card` per rebuild; after ◀/▶ jumps, `ensureGroupVisible()` scrolls the panel to the target card via `QScrollArea.ensureWidgetVisible(w, 40, 120)` with a 1-arg retry and a manual scrollbar-math fallback (`card.pos.y` centered in `viewport().height`).
2. **Timeline follows every jump** (scrubs *and* Frame/Sub links). `frame.setCurrent()` doesn't scroll the Timeline view and no documented action does, so `scrollTimelineToFrame()` drives the Timeline's own horizontal scrollbar:
   - `findTimelineScrollbar()` scans `QApplication.allWidgets()` for a horizontal `QScrollBar` whose parent chain (≤8 hops) has "timeline" in its `objectName`/`className`; cached per launch, revalidated in case the view was closed.
   - Frame ↔ scrollbar mapping: content span = `maximum + pageStep`; visible frame range ≈ `value/span·total … (value+page)/span·total`. **If the frame is already visible, don't move** (preserves the user's view); otherwise center: `value = (f-0.5)/total·span − page/2`, clamped. Zoom is untouched by construction — only the scroll position changes.
   - If the scrollbar hunt fails on some build, `dumpTimelineActionsOnce()` logs `Action.getActionList("timelineView")` filtered to frame/scroll/center/focus entries — round-two diagnostics, same workflow that cracked the cable issue.

Unproven-API notes: first live use of `QApplication.allWidgets()`, `metaObject().className()`, and `ensureWidgetVisible` in this project — all layered with fallbacks; worst case is today's behavior (no scroll), never breakage.

### v0.11.0 live test → v0.12.0
Part 1 (panel follow) **worked**; part 2 silently didn't: the log showed "scrollbar located" but never "scrolled" — the hunt grabbed the **wrong horizontal scrollbar**. The Timeline has at least two (layer-name column + frames area); the first-found one had range 0, and `scrollTimelineToFrame`'s `max <= 0` guard turned every jump into a silent no-op. Add to §7.3.5 instincts: *when hunting widgets by tree position, expect multiple plausible matches and pick by measurable property, not by first-found.*

v0.12.0 fixes and additions:
1. **Scrollbar picking by range** — collect all horizontal scrollbars under timeline-tagged parents, pick the one with the largest `maximum` (zoomed-in frames area wins by a huge margin); cache revalidated by range, not existence. All-zero ranges = scene fits on screen = correctly nothing to scroll. The action-list dump now fires only when *nothing* timeline-ish is found at all.
2. **Scrub-landing highlight** — `highlightGroup()` flashes a 2px white border on the group card the ◀/▶ navigation landed on, auto-clearing after 2.5 s (single-shot QTimer, keep-alive pinned). Deliberately styling-only: the user asked for "dismiss on click anywhere", but that would require the same global event-filter machinery that made card-clicks flaky in v0.8.x — the timed fade answers the same question ("where did it go?") with zero risk. Scoped via `#snGroupHL` ID selector so the border doesn't cascade to the note-card QFrames inside; cleared refs on refresh (widget is torn down).

Confirmed working in live test (both parts + highlight).

### v0.12.1 — scrub buttons gray out at the ends
`updateScrubButtons()` disables ◀/▶ (`btn.enabled = false`; Qt grays them natively) when no note frame exists strictly before/after the playhead — same `collectGroups` data as the jump, so state and behavior can't disagree. Update triggers: end of every `refresh()`, immediately after scrub/link jumps, and the `currentFrameChanged`-fed debounced tick for manual playhead moves (piggybacks the staleness timer; on a non-stale tick it updates buttons instead of rebuilding). Known trade-off: during continuous playback the debounce keeps postponing, so buttons settle ~300 ms after playback stops.

### v0.13.0 — launch means open, not create (+ removable empty subs)
User-reported oversight: every launch created a sub at the playhead (a literal reading of the original brief, correct only for first use), leaving stray empty subs the panel couldn't delete. Three changes:
1. **Launch creates a sub only on true first use** — when `column.getDrawingTimings()` is empty. Otherwise launching just opens the panel; Add Note is the only sub-creator.
2. **Noteless, unexposed drawings are hidden** from the list (`collectGroups` skips them, and skips empty note arrays left behind by deletions) — they carry no information.
3. **Removable empty groups** — groups with zero notes get a ✕ that calls `removeSubstitution()`: walk frames 1..N tracking the last non-target drawing (`prev`); every frame showing the target is re-keyed to `prev` ("" clears when nothing came before), so earlier exposure extends across the gap as if the sub never existed. `prev` deliberately not updated inside the span — that also flattens redundant mid-span keys. One undo step. Note-bearing subs are not removable (delete notes first). The drawing file stays in the element, hidden by rule 2.

### v0.14.0 — per-note check circles (student feedback)
Frame.io-style completion toggle on each note card: hollow gray circle = open, `SN_GREEN` circle + ✓ = done. Design decisions that keep it risk-free:
- **Data**: optional `done: bool` per note; missing (all pre-0.14 notes) reads as unchecked — no migration, no version bump.
- **Isolation**: toggling mutates the note, saves, and **restyles the button in place** (`styleDoneToggle`) — no `refresh()`, so scroll/drafts/highlight/focus are never touched. Rebuilds re-read `done` from the model. The metadata save may ping the notifier, but the signature check no-ops (no frames changed).
- **Mechanism**: plain `QPushButton` + `clicked.connect` (the never-failed pattern), circle via stylesheet `border-radius`, unicode ✓; styling failure degrades to a text ○/✓ toggle.
- Scope fences (not built, easy later): strikethrough/dim for done notes, hide-completed filter, done-counts on headers.
- **v0.14.1 (user taste pass):** circle shrunk 22px → 12px (radius 6, ✓ at 8px, `padding:0` so the glyph fits) and moved from the card's left edge to a right-side column — ✕ on top, circle centered directly beneath it, packed to the top with a spacer.
- **v0.14.2 (12px too small; interactivity request):** 24px filled design. Done = solid `SN_GREEN` circle + white ✓; hover/pressed = brighter (#66BB6A) / darker (#388E3C) steps of the same hue. Open = gray ring; hover brightens/thickens; press previews a translucent green fill. **All hover/press feedback via stylesheet `:hover`/`:pressed` pseudo-states** — the style engine tracks the mouse, zero script, zero event filters (the lesson of the v0.8.x saga applied to styling). Plus a guarded `PointingHandCursor`. Fallback agreed with user if 24px still feels off: restyle to match the ✕ box shape instead.
- **v0.14.4 (click-resize bug + dim-when-done):** clicking the toggle changed its size once, then stable — because applying/removing a stylesheet on a SHOWN button switches its render mode and recomputes the size hint (at build everything settles together; a click-time restyle re-lays-out just that button). Fix: **pin min=max width/height (28×24) on BOTH right-column buttons** so restyles are size-neutral by construction. New per student-UX: `dimNoteText()` grays the note text (#808080) while done — applied at build from the model and toggled in place with the circle, same no-refresh pattern.
- **v0.14.3 (fallback taken — native square):** the pseudo-states worked and felt great, but the custom-styled circle could never align with the natively-themed ✕ (different shape metrics, different hover border). Root lesson: **a custom-styled widget can't be made visually consistent with native-themed neighbors — match by NOT styling.** The toggle is now an unstyled native button, geometry-identical to the ✕ (same `maximumWidth`, no fixed size, no centering wrapper); state = glyph (○ open / bold `SN_GREEN` ✓ done). The only stylesheet left is the checked text color — flagged as the removal point if a color-only stylesheet suppresses native hover on some engine. Pointing-hand cursor dropped (✕ doesn't have one — consistency wins).

---

## 24. Implementation log — v0.15.0 (group scenes broke the connection logic)

First run in a **rigged scene** (`LL_Llama_Rig`, character inside a GROUP node) exposed two flaws — status bar read "renders BEHIND 45 layer(s)" and the cable was parked at the back on every run:

1. **Render rank was blind to groups.** `buildDefaultCompositionOrder()` enumerates nodes *inside* groups (by traversal, not composite port order), so the ~45 rig READs always counted as "ahead" of Notes → verification could never pass in group scenes, regardless of port order. Fixed: only **depth-0** items compete — top-level READ layers and GROUPs (a group ahead = its whole contents draw ahead = it counts as one layer). Uses `CompositionItem.depth` (docs: 0 = top-level); guarded.
2. **The failure exit parked Notes at the BACK.** Since v0.9.1 the strategy loop tries Notes-last (the proven front) *first* — so when both strategies failed verification, the final state was the last experiment: Notes-first = back port. Failing scenes were actively made worse on every run. Fixed: on total failure, re-apply Notes-last (the empirically-front order) before reporting honestly ("left on last port (usually front) — render check disagrees; diagnostics in Message Log").

Lesson for the pattern book: **a try-verify-retry loop must end on the best-known state, not on the last experiment.**

---

## 25. Implementation log — v0.16.0 (save-on-close)

Closes the last workflow gap (§7.3.5 #9: metadata reaches disk only on scene save). User decision: **option A — silent save when the panel closes**, chosen over a confirm-prompt (B, below), a sidecar backup file (C), and a passive reminder (D).

Implementation (`dlg.rejected` handler):
- Fires only when **notes changed this session** (`g_snNotesDirty`, module-level so it survives panel relaunches; set by `saveModel`, cleared on successful save or when the scene turns out clean) **and** `scene.isDirty()` — a manual Ctrl+S in between means no auto-save.
- Relaunch closes are marked via `setProperty("snSilentClose", true)` in `closeExistingDialog` and skipped — the new panel inherits responsibility.
- At most one `scene.saveAll()` per session-close → no repeated-save xstage churn (user's explicit concern).
- Outcome traced to the Message Log either way; a failed save warns to save manually.
- Known trade-off (accepted): `saveAll()` commits the **whole scene**, including any accidental artwork changes made while reviewing.
- Known edge (accepted): if Harmony re-evaluates the script file between panel sessions, `g_snNotesDirty` resets and notes added in the *previous* unsaved session won't trigger the auto-save.

### v0.17.0 — thin cards + new notes land at the top
1. **One-line note cards were ~55px tall** — the v0.14.1 vertical ✕-over-toggle stack set the card's minimum height to two buttons regardless of text. Cards can't be thin *and* keep the vertical stack, so (user-approved trade-off) the ✕ and toggle now sit **side by side in the top-right corner** (24px block), with a spacer pinning them top on tall cards.
2. **Add Note now scrolls the new group to the TOP of the viewport** (`scrollGroupToTop`: card `pos.y` − 6px margin into the scrollbar, clamped) instead of merely "visible" — its header + input land right under the toolbar, per user mock. `focusGroup` keeps the double-apply (immediate + 60 ms) for post-rebuild layout settling; the ◀/▶ scrub still uses centered `ensureWidgetVisible` (different intent: orienting within a list vs. presenting a fresh input).

### §25.1 — Backup design: option B, the confirm-prompt variant
Kept on the shelf for if teachers ask to confirm saves (likely feedback per user). Same triggers and guards as A, but instead of silently calling `saveAll()`:
- Show a two-button dialog: *"You added notes this session — save the scene now so they aren't lost?"* **[Save] [Not Now]**.
- API: `MessageBox.warning(text, button0, button1, button2, title, parent)` supports up to 3 buttons (pass 1 to show, 0 to hide) — **verified to exist, but the return-value semantics are under-documented** (classic Qt3-style: expected to return the pressed button's index/value). Needs one live probe: log the return value for each button before trusting it. If the return proves undecipherable, degrade to option D (amber "unsaved notes — Ctrl+S" status-bar reminder) rather than guessing.
- Switch is localized: replace the `scene.saveAll()` call inside the `dlg.rejected` handler with the prompt logic; everything else (dirty tracking, silent-close marker) is shared.

### v0.12.2 — Add Note focuses the new group; thinner highlight
- `refresh(focusDrawing)` optional param: when set (used by the Add Note button), the rebuild **skips the scroll-position restore** and instead scrolls to + flashes that group (`focusGroup()` — applied immediately and again at 60 ms, because the restore path's own delayed timer taught us post-rebuild scrolls get clamped before layout settles; the two mechanisms are mutually exclusive per refresh so they can't fight).
- Highlight border 2px → 1px (user taste).

---

## Sources
- column class (getEntry/setEntry/getElementIdOfDrawing/add/getDrawingTimings): https://docs.toonboom.com/help/harmony-22/scripting/script/classcolumn.html
- element class (add/id/getNameById/physicalName): https://docs.toonboom.com/help/harmony-22/scripting/script/classelement.html
- scene class (setMetadata/metadata/metadatas/currentProjectPath): https://docs.toonboom.com/help/harmony-22/scripting/script/classscene.html
- Drawing class: https://docs.toonboom.com/help/harmony-20/scripting/script/classDrawing.html
- node class: https://docs.toonboom.com/help/harmony-21/scripting/script/classnode.html
- MetaDataHandler (concept/persistence): https://docs.toonboom.com/help/harmony-24/scripting/python/class_o_m_c_1_1_meta_data_handler.html
- Dialog class (simplified UI): https://docs.toonboom.com/help/harmony-22/scripting/script/classDialog.html
- Creating Qt Scripts: https://docs.toonboom.com/help/harmony-22/premium/scripting/create-qt-script.html
- QScrollArea (widgetResizable): https://doc.qt.io/qt-6/qscrollarea.html
- OpenHarmony (community JS API reference): https://github.com/cfourney/OpenHarmony
