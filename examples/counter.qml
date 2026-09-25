import OpenTUI

Window {
    id: root
    color: "#1a1b26"

    property int count: 0
    readonly property bool isEven: count % 2 === 0

    Keys.onPressed: (event) => {
        switch (event.key) {
            case "up": case "k": case "+": count++; break
            case "down": case "j": case "-": count--; break
            case "r": count = 0; break
            case "q": case "escape": Qt.quit(); break
        }
    }

    Rectangle {
        anchors.centerIn: parent
        width: 34
        height: 9
        color: "#24283b"
        border.width: 1
        border.color: isEven ? "#9ece6a" : "#f7768e"
        radius: 1
        title: " Counter "
        titleAlignment: "center"
        padding: 1
        flexDirection: "column"
        alignItems: "center"
        justifyContent: "center"
        gap: 1

        Text {
            text: "Count: " + root.count
            color: "#c0caf5"
            font.bold: true
        }

        Text {
            text: root.isEven ? "even" : "odd"
            color: root.isEven ? "#9ece6a" : "#f7768e"
        }

        Text {
            text: "↑/↓ or j/k to change · r to reset · q to quit"
            color: "#565f89"
        }
    }
}
