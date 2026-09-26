import OpenTUI

// Rich text: span children of Text. `text` is the leading segment; spans follow it and nest.
Window {
    id: root
    color: "#1a1b26"

    property int clicks: 0

    Keys.onPressed: (event) => {
        if (event.key === "q" || event.key === "escape") Qt.quit()
        else if (event.key === "space") clicks++
    }

    Rectangle {
        anchors.centerIn: parent
        width: 60
        height: 12
        color: "#24283b"
        border.width: 1
        border.color: "#7aa2f7"
        title: " Rich text "
        padding: 1
        flexDirection: "column"
        gap: 1

        Text {
            color: "#c0caf5"
            text: "Styles: "
            Bold { text: "bold " }
            Italic { text: "italic " }
            Underline { text: "underline " }
            Strikethrough { text: "strike " }
            Dim { text: "dim" }
        }

        Text {
            color: "#c0caf5"
            text: "Nested: "
            Span {
                color: "#9ece6a"
                text: "green "
                Bold { text: "and bold " ; Italic { text: "and italic" } }
            }
        }

        Text {
            color: "#c0caf5"
            text: "Reactive: "
            Bold { color: "#e0af68"; text: root.clicks + " presses of space" }
            Br {}
            Span { text: "Links: " }
            Link { href: "https://opentui.com"; text: "opentui.com" }
        }

        Text {
            text: "space to count · q to quit"
            color: "#565f89"
        }
    }
}
