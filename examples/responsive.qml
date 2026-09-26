import OpenTUI

// Layout driven by the terminal size through the Screen singleton.
Window {
    id: root
    color: "#1a1b26"

    readonly property bool wide: Screen.width >= 70
    property int resizes: 0

    Screen.onResized: (w, h) => resizes++

    Keys.onPressed: (event) => {
        if (event.key === "q" || event.key === "escape") Qt.quit()
    }

    Column {
        padding: 1
        gap: 1
        flexGrow: 1

        Text {
            text: "Terminal: " + Screen.width + "x" + Screen.height + " (" + (root.wide ? "wide" : "narrow") + " layout)"
            color: "#7aa2f7"
            font.bold: true
        }

        Item {
            flexDirection: root.wide ? "row" : "column"
            gap: 1
            flexGrow: 1

            Rectangle {
                flexGrow: 1
                minHeight: 3
                border.width: 1
                border.color: "#9ece6a"
                title: " Sidebar "
                padding: 1
                Text { text: root.wide ? "Side by side" : "Stacked"; color: "#c0caf5" }
            }

            Rectangle {
                flexGrow: 2
                minHeight: 3
                border.width: 1
                border.color: "#e0af68"
                title: " Main "
                padding: 1
                Text { text: "Resized " + root.resizes + " times"; color: "#c0caf5" }
            }
        }

        Text { text: "Resize the terminal · q to quit"; color: "#565f89" }
    }
}
