import OpenTUI

Window {
    id: root
    color: "#1a1b26"

    Keys.onPressed: (event) => {
        if (event.key === "escape" || event.key === "q") Qt.quit()
    }

    Column {
        anchors.centerIn: parent
        spacing: 1

        AsciiText {
            text: "OpenTUI"
            font: "block"
            color: "#7aa2f7"
        }

        Text {
            text: "Hello from QML!"
            color: "#c0caf5"
            font.bold: true
        }

        Text {
            text: "Press q or Esc to quit"
            color: "#565f89"
        }
    }
}
