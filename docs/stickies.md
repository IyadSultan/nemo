# Product Requirements Document
# Second Brain — Intelligent Sticky Notes Module

**Version:** 1.0  
**Status:** Ready for implementation  
**Integration:** Existing Second Brain application and Rust AI agent

## 1. Product objective

Build a visually rich, AI-powered Sticky Notes module integrated into the existing Second Brain application.

The module should recreate the experience of a traditional wooden bulletin board with colorful paper sticky notes, realistic shadows, handwritten text, and flexible positioning, while adding modern functionality such as intelligent organization, semantic search, automatic titles and hashtags, task management, and natural-language agent control.

The interface must be fast, intuitive, and visually appealing. Users should be able to create a note with one action, without navigating complicated forms.

The implementation must reuse the existing Second Brain authentication, persistence, AI agent, and application architecture wherever possible.

## 2. Board appearance and customization

### 2.1 Background themes

The default background must be a **classic wooden bulletin board**, with a realistic wood texture.

Provide the following background options:

- Classic wooden bulletin board (default)
- Cork bulletin board
- Dark wooden board
- Plain white
- Plain black
- Soft gray
- Custom solid color
- User-uploaded background image

Users can change the background through board settings.

Background selection should persist between sessions and can be configured separately for individual boards.

### 2.2 Light and dark mode

Implement three appearance settings:

- Light
- Dark
- Follow system preference

Dark mode should adjust the toolbar, menus, settings, editor controls, and surrounding application interface. Board background selection should remain independent of light/dark mode unless the user chooses automatic theme matching.

### 2.3 Realistic sticky-note design

Each sticky note should visually resemble a physical piece of paper attached to a bulletin board.

Features:

- Soft drop shadows
- Slightly raised paper appearance
- Optional subtle paper texture
- Optional small rotation for a natural appearance
- Smooth dragging and repositioning
- Resizable width and height
- Rounded or square corners, configurable
- Adjustable shadow intensity
- Optional pin or tape visual decoration
- Selected-note elevation and outline

Notes should cast realistic shadows without excessive animation or performance overhead.

## 3. Handwriting and typography

### 3.1 Text appearance

Users must be able to choose between:

1. **Classic handwriting:** Text is typed normally but displayed using a handwriting-style font.
2. **Standard typing:** Text appears using a clean, readable sans-serif font.

Provide global default typography preferences and per-note overrides.

### 3.2 Typography settings

Allow users to configure:

- Font family
- Font size
- Text color
- Bold, italic, underline
- Line spacing
- Text alignment
- Handwriting or typing mode

Offer several handwriting font styles, including support for Arabic handwriting where suitable fonts are available.

### 3.3 Optional freehand writing

Provide an extensible design for actual pen/stylus handwriting on notes.

This is distinct from handwriting-style typography. If implemented, pen strokes should be stored separately from typed text and remain editable.

Freehand writing is a secondary priority; handwriting-style fonts are required for the initial release.

## 4. Creating and editing notes

### 4.1 Note creation

Users can create notes through:

- A prominent **+ New Note** button
- Double-clicking an empty board location
- Right-clicking the board and choosing New Note
- Keyboard shortcut
- Natural-language command through the existing AI agent

When creating a note, allow the user to choose a color immediately.

The new note should appear at the cursor location when created from the board, or at an available visible position when created through a toolbar or agent command.

Focus the editor automatically.

### 4.2 Note editor

Support:

- Inline editing
- Autosave
- Multiline text
- Basic rich-text formatting
- Hyperlinks
- Checklists
- Undo/redo
- Duplicate note
- Delete note
- Archive note
- Convert note to task
- Pin note
- Resize and reposition note

Edits should not require an explicit Save button.

### 4.3 Context menu

Right-clicking a note should open a context menu with:

- Edit
- Change color
- Change font
- Copy
- Duplicate
- Add hyperlink
- Link to another note
- Convert to to-do
- Set priority
- Set reminder
- Pin/unpin
- Archive
- Delete

On touch devices, equivalent actions should be available through a long-press or overflow menu.

## 5. Colors and thematic classification

### 5.1 Sticky-note colors

Provide a palette containing:

- Yellow
- Pink
- Blue
- Green
- Orange
- Purple
- White
- Gray
- Custom color

The user can select a note color during creation or change it later.

### 5.2 Color themes

Allow users to associate colors with categories or themes.

Example:

| Color | User-defined meaning |
|---|---|
| Yellow | General ideas |
| Pink | Urgent |
| Blue | Work |
| Green | Completed or personal |
| Orange | Follow-up |
| Purple | Research |

These are examples only. The user must be able to define, rename, and modify color-category associations.

Colors should remain independent of AI-generated priority unless the user explicitly enables automatic priority-based coloring.

### 5.3 Default color

Allow users to choose:

- Always use a particular color
- Reuse the last selected color
- Ask for color when creating a note
- Automatically choose a color based on classification

## 6. AI-generated metadata

Every note should have AI-assisted metadata generated using the existing Rust agent.

### 6.1 Automatic title generation

When a note is created or substantially edited, the AI should generate a concise, meaningful title based on its contents.

Requirements:

- Prefer short, descriptive titles
- Store title separately from note body
- Allow manual editing
- Never overwrite a manually locked title
- Use the title for alphabetical sorting
- Support Arabic and English

Example:

**Note body:** "Need to meet the development team next week to review the mobile application."

**AI title:** "Mobile Application Review Meeting"

### 6.2 Automatic hashtag generation

The AI should produce relevant hashtags for every note.

Example:

`#Development #MobileApp #Meeting #FollowUp`

Requirements:

- Generate approximately 2–5 meaningful hashtags when appropriate
- Avoid duplicate or redundant hashtags
- Reuse existing tags when semantically appropriate
- Allow users to add, remove, and rename hashtags
- Make hashtags clickable
- Filter and group notes by hashtag
- Support multilingual hashtags

Hashtags should be normalized internally for searching while preserving their display text.

### 6.3 Automatic priority classification

The AI should classify the note according to its content.

Priority values:

- Critical
- High
- Medium
- Low
- None

The AI should also determine whether the note contains an actionable task.

Store priority and task classification as separate fields.

For example, an important reference note may have high priority without being a to-do item.

AI-generated priorities should be suggestions, with user overrides taking precedence.

### 6.4 Metadata generation behavior

AI processing should occur asynchronously after the note is saved.

The interface must never wait for AI processing before allowing further editing.

Regenerate metadata when the content changes meaningfully, using debounce and background processing.

Use content versioning to prevent an older AI response from overwriting metadata generated from newer content.

If the AI service fails, retain the note and allow metadata generation to be retried.

## 7. Sorting, filtering, and organization

### 7.1 Sorting options

Users must be able to organize notes by:

- Color
- Creation date, newest first
- Creation date, oldest first
- Last modified date
- Alphabetical title, A–Z
- Alphabetical title, Z–A
- Hashtag
- Priority
- Due date
- Manual position

### 7.2 Sorting versus filtering

Sorting changes the display order or arrangement of notes.

Filtering controls which notes are visible.

Provide filters for:

- Color
- Hashtag
- Priority
- Task status
- Date range
- Archived status
- Pinned status
- Search query

Support multiple simultaneous filters.

### 7.3 Board arrangement

Provide two main viewing modes:

**Freeform board**

Users position notes anywhere, with drag-and-drop and persistent coordinates.

**Organized board**

Notes automatically arrange in rows, columns, or groups according to the selected sorting criterion.

Changing to organized mode must not destroy manual note coordinates.

Returning to freeform mode should restore the previously saved positions.

### 7.4 Grouping

Support grouping by:

- Color
- Hashtag
- Priority
- Date
- Task status

When grouping by hashtags, a note with multiple hashtags may appear in multiple virtual groups without creating duplicate database records.

## 8. To-do list functionality

### 8.1 Convert sticky note to to-do

Any sticky note can be converted into a task with one click.

The original note content must be preserved.

Task fields:

- Title
- Description
- Priority
- Due date
- Reminder
- Completion status
- Completion date
- Hashtags
- Color
- Linked notes

### 8.2 Conversion behavior

Support two-way conversion:

- Sticky note → To-do
- To-do → Sticky note

A converted item should retain the same unique identifier wherever the existing data architecture permits.

Conversion must not cause data loss.

### 8.3 Checklist notes

Support multiple checklist items within one note.

Each checklist item can be checked independently.

Show completion progress when appropriate.

### 8.4 Task views

Provide:

- All tasks
- Today
- Upcoming
- Overdue
- Completed
- High priority

Users should be able to switch between the bulletin board and task-list views.

## 9. Archive and deletion

### 9.1 Archive

Each note can be archived without being deleted.

Archived notes:

- Disappear from the active board by default
- Remain searchable
- Preserve all content and metadata
- Can be restored to their original board and position

Provide an Archive view with search and filtering.

### 9.2 Delete

Deleting a note should initially move it to Trash.

Provide:

- Restore
- Permanent deletion
- Bulk deletion
- Configurable trash retention policy

Destructive operations initiated by the agent must follow the application's confirmation policy.

## 10. Zooming and navigation

### 10.1 Zoom controls

Implement:

- Zoom in
- Zoom out
- Reset to 100%
- Fit all notes
- Zoom to selected note

Support mouse wheel or trackpad zoom with appropriate modifier behavior, and pinch-to-zoom on touch devices.

Suggested zoom range: 25%–300%.

### 10.2 Board navigation

Provide:

- Pan by dragging empty board space
- Smooth zoom centered around the pointer
- Optional mini-map
- Fit-to-content action
- Keyboard navigation

Zoom and pan state should persist per board.

## 11. Hyperlinks and relationships

### 11.1 Hyperlinks within notes

Users should be able to select text, right-click, and choose **Add Link**.

The action should allow linking to:

- External website
- Another sticky note
- Another Second Brain item
- A document or resource supported by the existing application

Display hyperlinks clearly and open them through the appropriate application mechanism.

### 11.2 Link a complete note

Allow a whole sticky note to reference another object.

For example:

- Note → Note
- Note → Task
- Note → Document
- Note → Existing Second Brain record

Support a dedicated **Copy Note Link** action.

Links should use stable identifiers, not board coordinates or generated titles.

### 11.3 Note relationships

Store relationships in a structured form so they can be retrieved by the AI agent.

Optionally visualize relationships between notes in a future graph view.

## 12. Rust AI agent integration

The Sticky Notes module must be accessible through the existing Second Brain agent.

Do not build an independent agent.

Expose a typed tool interface through the application's established agent/tool mechanism.

### 12.1 Required agent operations

| Tool | Function |
|---|---|
| `sticky_note_create` | Create a note |
| `sticky_note_update` | Edit a note |
| `sticky_note_delete` | Delete a note |
| `sticky_note_archive` | Archive a note |
| `sticky_note_restore` | Restore a note |
| `sticky_note_search` | Find notes |
| `sticky_note_list` | List notes using filters |
| `sticky_note_classify` | Generate title, hashtags, and priority |
| `sticky_note_set_color` | Change note color |
| `sticky_note_set_priority` | Change priority |
| `sticky_note_convert_to_task` | Convert note into a task |
| `sticky_note_set_reminder` | Add or update a reminder |
| `sticky_note_link` | Link notes or resources |
| `sticky_note_move` | Change note board or position |
| `sticky_note_sort` | Change board arrangement |

### 12.2 Natural-language commands

The agent should understand commands such as:

**Creation**

"Create a yellow sticky note reminding me to review the research proposal tomorrow."

**Editing**

"Find my note about the mobile app and add that the deadline is Friday."

**Deletion**

"Delete the sticky note about the canceled meeting."

**Organization**

"Show all my pink sticky notes."

"Arrange the notes alphabetically."

"Group all my notes according to their hashtags."

**Tasks**

"Convert the note about the conference presentation into a high-priority task."

**AI operations**

"Find my most important unfinished tasks."

"Generate hashtags for all notes that do not have them."

"Show me all sticky notes related to AI research."

**Archiving**

"Archive all completed notes from last month."

### 12.3 Agent safety and disambiguation

When an agent command refers to a specific note:

1. Resolve the target using search and stable note IDs.
2. If multiple notes match, ask the user to select the intended note.
3. Never silently modify an arbitrary matching note.
4. Confirm ambiguous or high-impact destructive actions.
5. Respect existing user permissions and workspace boundaries.
6. Record agent-initiated changes in the application audit mechanism.

The agent should be able to operate on individual notes and filtered collections.

Agent tools should return structured results, including note IDs, operation status, and errors.

## 13. Suggested data model

Use the existing Second Brain persistence layer and conventions.

A logical note record should include:

| Field | Type |
|---|---|
| `id` | UUID |
| `board_id` | UUID |
| `content` | Rich text / Markdown |
| `title` | String |
| `title_source` | AI / user |
| `title_locked` | Boolean |
| `hashtags` | Array / relation |
| `color` | Color token |
| `priority` | Enum |
| `priority_source` | AI / user |
| `note_type` | Note / task |
| `task_status` | Enum |
| `due_at` | Optional datetime |
| `reminder_at` | Optional datetime |
| `is_pinned` | Boolean |
| `archived_at` | Optional datetime |
| `deleted_at` | Optional datetime |
| `created_at` | Datetime |
| `updated_at` | Datetime |
| `completed_at` | Optional datetime |
| `position_x` | Float |
| `position_y` | Float |
| `width` | Float |
| `height` | Float |
| `rotation` | Float |
| `font_style` | Enum |
| `font_size` | Number |
| `content_version` | Integer |
| `metadata_version` | Integer |
| `linked_resources` | Relation |

Store board settings separately, including background, layout mode, sort criterion, zoom, pan, and appearance preferences.

Represent checklists, links, reminders, and handwritten strokes using structured child records where necessary.

## 14. Technical integration requirements

Before implementing, inspect the existing Second Brain repository to determine:

- Current frontend framework
- Rust agent implementation and tool registry
- Backend/API architecture
- Authentication and authorization
- Database schema and migrations
- Existing task/reminder model
- Search and indexing capabilities
- UI theme and component system

Reuse these components rather than introducing parallel infrastructure.

The module should:

- Use existing authentication and user identity
- Respect workspace access permissions
- Integrate with existing search
- Reuse existing task/reminder services when available
- Follow established API and error-handling conventions
- Support responsive layouts
- Persist board coordinates and user preferences
- Handle concurrent edits safely
- Support local draft recovery if the application architecture permits

AI calls should pass through the existing Rust agent or its established model gateway. Do not hard-code a new AI provider.

## 15. Performance and reliability

- Creating a note must feel immediate.
- Typing and dragging must remain responsive.
- Autosave should use a short debounce.
- AI classification must never block editing.
- Board rendering should support large collections of notes.
- Avoid unnecessary re-rendering during drag and zoom.
- Use virtualization or viewport culling for large boards where appropriate.
- Restore unsaved drafts after interruptions when possible.
- Preserve user data during network or AI failures.

Target smooth interactions on ordinary desktop hardware.

## 16. Accessibility and multilingual support

Support English and Arabic.

Requirements:

- RTL and LTR text
- Mixed Arabic/English content
- Unicode-aware alphabetical sorting
- Arabic-capable handwriting-style fonts
- Keyboard navigation
- Screen-reader labels
- Visible focus indicators
- Accessible contrast options
- Reduced-motion preference
- Touch-friendly controls

Do not rely exclusively on note color to communicate priority or task status.

## 17. Implementation phases

### Phase 1 — Core board

- Wooden bulletin board
- Background themes
- Dark mode
- Realistic shadows
- Create/edit/delete notes
- Colors
- Handwriting-style and standard fonts
- Drag/resize
- Autosave
- Zoom and pan
- Sorting and filtering
- Archive and restore

### Phase 2 — Intelligence and tasks

- AI-generated titles
- AI-generated hashtags
- AI priority classification
- Note-to-task conversion
- Task-list view
- Due dates and reminders
- Hashtag grouping
- Hyperlinks and internal note links

### Phase 3 — Agent integration

- Rust agent tool registration
- Natural-language creation and editing
- Note search and target resolution
- Agent-controlled organization
- Agent-controlled task conversion
- Safe deletion and archiving
- Bulk actions with appropriate confirmation

### Phase 4 — Advanced enhancements

- Freehand stylus input
- Mini-map
- Relationship visualization
- Additional backgrounds and textures
- Advanced semantic organization
- Bulk AI metadata regeneration

## 18. Acceptance criteria

The implementation is complete when the following scenarios work:

1. A new board displays a wooden bulletin-board background with realistic paper notes and shadows.
2. A user changes the background and enables dark mode; preferences persist after restart.
3. A user creates a pink note and switches its font from handwriting-style to standard typing.
4. The AI generates a title, hashtags, and priority without delaying note creation.
5. A user edits the generated title, locks it, and subsequent AI processing preserves it.
6. Notes can be arranged alphabetically using their stored titles.
7. Notes can be grouped and filtered by colors, hashtags, dates, and priorities.
8. Switching between organized and freeform layouts preserves manual positions.
9. A user converts a sticky note to a task and later converts it back without losing content.
10. A user archives a note and restores it with its original metadata and position.
11. Zoom, pan, drag, and resizing work smoothly.
12. A user selects text and inserts a hyperlink through the context menu.
13. A user links one note to another using a stable internal link.
14. The Rust agent creates a note from a natural-language instruction.
15. The agent searches for and updates the correct existing note.
16. The agent requests disambiguation when multiple notes match a deletion request.
17. Notes remain usable when AI services are temporarily unavailable.
18. Arabic and English notes render, sort, and search correctly.

## 19. Instructions to the coding agent

Implement this as a native module of the existing Second Brain application.

**Important constraints:**

1. Inspect the existing repository and architecture before making changes.
2. Reuse the existing Rust AI agent and its tool-calling infrastructure.
3. Do not introduce a second AI agent, authentication system, or database unnecessarily.
4. Preserve all existing Second Brain functionality.
5. Use database migrations and maintain backward compatibility.
6. Build reusable note, board, editor, toolbar, context-menu, and settings components.
7. Keep user-defined metadata authoritative over AI suggestions.
8. Keep visual organization independent of persistent note content.
9. Provide automated tests for CRUD, sorting, archiving, task conversion, agent actions, and metadata generation.
10. Document new APIs, tool schemas, configuration options, and migrations.
11. Follow the existing project's coding conventions.
12. Do not claim successful integration without executing applicable tests.

**Final deliverable:** A fully integrated, visually polished, AI-powered Sticky Notes module within Second Brain, controlled both through its graphical interface and the existing Rust agent.
