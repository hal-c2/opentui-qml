import OpenTUI

Window {
    id: root
    color: "#1a1b26"
    flexDirection: "column"
    padding: 1
    gap: 1

    ListModel {
        id: todos
        ListElement { title: "Write a QML file"; done: true }
        ListElement { title: "Run it with opentui-qml"; done: false }
        ListElement { title: "Customise the colours"; done: false }
    }

    function toggle(i) {
        todos.setProperty(i, "done", !todos.get(i).done)
    }

    Keys.onPressed: (event) => {
        if (event.key === "escape") Qt.quit()
        if (event.key === "tab") input.focus = true
    }

    Text {
        text: "Todos (" + todos.count + ")"
        color: "#7aa2f7"
        font.bold: true
    }

    Rectangle {
        border.width: 1
        border.color: "#414868"
        flexDirection: "column"
        padding: 1
        flexGrow: 1

        Repeater {
            model: todos
            delegate: Text {
                text: (done ? "[x] " : "[ ] ") + (index + 1) + ". " + title
                color: done ? "#565f89" : "#c0caf5"
            }
        }
    }

    Row {
        spacing: 1
        Text { text: "Add:"; color: "#9ece6a" }
        TextInput {
            id: input
            focus: true
            flexGrow: 1
            placeholderText: "What needs doing? (Enter to add, Esc to quit)"
            backgroundColor: "#24283b"
            focusedBackgroundColor: "#2f3549"
            onAccepted: {
                if (text.trim().length > 0) {
                    todos.append({ title: text.trim(), done: false })
                    text = ""
                }
            }
        }
    }
}
