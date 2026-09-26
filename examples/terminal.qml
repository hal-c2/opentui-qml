import OpenTUI

// An EmbeddedTerminal running your shell inside a bordered pane, with a status line.
// While the terminal has focus every key goes to the shell, except the `hostKeys`
// (Escape here, the default) and `context: "application"` shortcuts:
//
//   escape   focus the command box (Enter sends its text to the shell, Escape returns)
//   ctrl+q   quit (application shortcut, works even while the shell has focus)
//   ctrl+r   restart the shell (only while the command box has focus)
Window {
    id: root
    color: "#1a1b26"
    flexDirection: "column"
    padding: 1
    gap: 1

    Shortcut { sequence: "ctrl+q"; context: "application"; onActivated: Qt.quit() }
    Shortcut { sequence: "ctrl+r"; onActivated: term.restart() }
    Shortcut { sequence: "escape"; onActivated: term.activeFocus ? input.forceActiveFocus() : term.forceActiveFocus() }

    Rectangle {
        flexGrow: 1
        border.width: 1
        border.color: term.activeFocus ? "#7aa2f7" : "#414868"
        title: " " + (term.running ? "pid " + term.pid : "exited " + term.exitCode) + " "

        EmbeddedTerminal {
            id: term
            flexGrow: 1
            shell: true                 // $SHELL, or command: "htop"; args: ["-d", "10"]
            focus: true
            maxScrollback: 200000
            onExited: (code, signal) => root.last = "shell exited with " + code + (signal ? " (" + signal + ")" : "")
            onTerminalResized: (cols, rows) => root.size = cols + "x" + rows
        }
    }

    property string last: ""
    property string size: ""

    Row {
        gap: 1
        Text { text: "$"; color: "#9ece6a" }
        TextInput {
            id: input
            flexGrow: 1
            placeholderText: "type a command, Enter runs it in the shell"
            onAccepted: { term.send(text + "\r"); text = ""; term.forceActiveFocus() }
        }
    }

    Text {
        color: "#565f89"
        text: (term.activeFocus ? "terminal has focus (Esc: command box)" : "command box (Esc: terminal, ctrl+r: restart)")
              + "  " + root.size + "  " + root.last + "  ctrl+q quits"
    }
}
