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
8. **Composite port order: the LEFTMOST input port renders in FRONT — and you cannot insert there directly.** Live testing proved `node.link(src, 0, comp, 0, false, true)` does **not** insert at port 0: when the port is occupied, `mayAddInputPort` **appends a new port at the right end** (= back), regardless of the `dstPort` you pass. An unlink-then-relink of just one cable therefore also lands at the back. The only deterministic way to put a node frontmost is to **rebuild the whole port order** — snapshot every input (`node.srcNodeInfo(comp, i)` for `{node, port}`, falling back to `srcNode`), unlink all ports high→low, then relink with your node first (ports fill left→right in connection order). Wrap it in one undo accum and skip it entirely when already frontmost. See `bringToFrontOfComposite()`.
9. **Scene metadata persists only when the scene is saved.** `scene.setMetadata` updates the in-memory scene; the data reaches the `.xstage` on scene save. Unsaved session = unsaved notes.

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
