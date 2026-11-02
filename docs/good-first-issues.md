# Good first issues

Drafts of small, self-contained tasks to open on GitHub with the `good first issue` label. Delete an entry once its issue exists.

## Add an "AI tools" section in Settings

Hooks can only be installed from the command line. Add a Settings section with one switch per tool that runs the same logic as `--aizbrain-hook install` and shows the settings file it changed.

## Make month-view tasks readable when the side panel is open

With the day panel open, month cells cut task titles down to about two letters. Show a dot-and-count summary at narrow widths, or close the panel on small windows.

## Support OpenCode hooks

OpenCode currently relies on the rule file only. Investigate its plugin system and add session-start context and the write-back reminder, following `apps/desktop/src-tauri/src/ai_hook.rs`.

## Add a Linux build

Add a Linux job modeled on `.github/workflows/macos.yml` and fix what breaks. `key_store.rs` needs a Linux secret-storage backend.

## Weekly review: copy as Markdown

Add a button on the Review dialog that copies the week's summary as Markdown, so people can paste it into a journal or share it.
