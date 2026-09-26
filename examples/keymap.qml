import OpenTUI

// Keyboard shortcuts on @opentui/keymap: multi-key sequences, a leader key, an Action with a
// shortcut, an "item" keymap that is active only while the list has focus, and a help footer
// built from Keyboard.activeKeys().
//
//   j / k        move            gg / G         first / last
//   ctrl+x ctrl+s  save          mod+s          save (Action)
//   space d      delete (leader) space q        quit (leader)
//   /            focus the filter (typing j/k/g there is not stolen)   escape  back to the list
Window {
    id: root
    color: "#1a1b26"
    flexDirection: "column"
    padding: 1
    gap: 1

    property int current: 0
    property string status: "Press a key. Sequences show up in the footer while pending."

    ListModel {
        id: files
        ListElement { name: "README.md" }
        ListElement { name: "package.json" }
        ListElement { name: "src/index.ts" }
        ListElement { name: "src/cli.ts" }
        ListElement { name: "docs/DESIGN.md" }
    }

    function move(delta) {
        current = Math.max(0, Math.min(files.count - 1, current + delta))
    }

    // Standalone Action: a command with a shortcut. `Keyboard.dispatch("save")` and
    // `saveAction.trigger()` run it too.
    Action {
        id: saveAction
        name: "save"
        text: "Save"
        shortcut: "mod+s"
        category: "File"
        onTriggered: root.status = "Saved " + files.get(root.current).name
    }

    // The main keymap. `<leader>` is `space`; "gg" and "ctrl+x ctrl+s" are sequences.
    Keymap {
        name: "main"
        leader: "space"
        bindings: ({
            "gg": { action: "first", description: "First file" },
            "G": { action: "last", description: "Last file" },
            "ctrl+x ctrl+s": { action: "save", description: "Save (emacs)" },
            "<leader>d": { action: "delete", description: "Delete file" },
            "<leader>q": { action: "quit", description: "Quit" },
            "/": { action: "filter", description: "Filter" },
        })
        handlers: ({
            first: () => root.current = 0,
            last: () => root.current = files.count - 1,
            save: () => saveAction.trigger(),
            delete: () => {
                if (files.count === 0) return
                root.status = "Deleted " + files.get(root.current).name
                files.remove(root.current)
                root.move(0)
            },
            quit: () => Qt.quit(),
            filter: () => filter.forceActiveFocus(),
        })
    }

    // Escape leaves the filter. `escape` is not a text-editing key, so a "window" Shortcut
    // fires even while the TextInput has focus.
    Shortcut {
        sequence: "escape"
        description: "Back to list"
        onActivated: (event) => {
            if (!filter.focus) { event.accepted = false; return }   // fall through
            list.forceActiveFocus()
        }
    }

    Text { text: "Files"; color: "#7aa2f7"; font.bold: true }

    Rectangle {
        id: list
        focus: true
        border.width: 1
        border.color: focus ? "#7aa2f7" : "#414868"
        flexDirection: "column"
        paddingLeft: 1
        paddingRight: 1
        flexGrow: 1

        // Active only while focus is inside the list ("item" context).
        Keymap {
            context: "item"
            bindings: ({
                "j": { action: "down", description: "Down" },
                "k": { action: "up", description: "Up" },
                "down": "down",
                "up": "up",
            })
            handlers: ({ down: () => root.move(1), up: () => root.move(-1) })
        }

        Repeater {
            model: files
            delegate: Text {
                visible: name.indexOf(filter.text) !== -1
                text: (index === root.current ? "> " : "  ") + name
                color: index === root.current ? "#e0af68" : "#c0caf5"
            }
        }
    }

    Row {
        spacing: 1
        Text { text: "Filter:"; color: "#9ece6a" }
        TextInput {
            id: filter
            flexGrow: 1
            placeholderText: "press / to type, escape to go back"
            backgroundColor: "#24283b"
            focusedBackgroundColor: "#2f3549"
        }
    }

    Text { text: root.status; color: "#bb9af7" }

    // Help footer: what can be pressed right now (continuations while a sequence is pending).
    Text {
        text: (Keyboard.pendingSequence ? "[" + Keyboard.pendingSequence + "] " : "") +
            Keyboard.activeKeys().map((k) => k.key + " " + (k.description || k.command)).join("  ")
        color: "#565f89"
        wrapMode: Text.Wrap
    }
}
