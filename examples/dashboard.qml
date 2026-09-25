import OpenTUI

// A small "dashboard" shell: a sidebar list, a content pane whose text follows the
// selection, a status bar, and a clock driven by a Timer. Everything here is plain
// QML so a user can restyle it without touching TypeScript.
Window {
    id: root
    color: "#1a1b26"
    flexDirection: "column"

    property string clock: ""
    property var pages: [
        { name: "Overview", description: "Summary of everything", body: "Welcome to the dashboard.\nUse ↑/↓ to switch pages." },
        { name: "Metrics", description: "Numbers go here", body: "CPU 12%  MEM 48%  DISK 71%" },
        { name: "Logs", description: "Recent events", body: "12:00 boot\n12:01 ready\n12:05 request /api" },
        { name: "About", description: "This app", body: "opentui-qml demo. Edit dashboard.qml to change me." }
    ]

    Timer {
        interval: 1000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.clock = new Date().toLocaleTimeString()
    }

    Keys.onPressed: (event) => {
        if (event.key === "q" || event.key === "escape") Qt.quit()
    }

    Rectangle {
        height: 3
        color: "#24283b"
        border.width: 1
        border.color: "#414868"
        flexDirection: "row"
        justifyContent: "space-between"
        paddingLeft: 1
        paddingRight: 1

        Text { text: "opentui-qml dashboard"; color: "#7aa2f7"; font.bold: true }
        Text { text: root.clock; color: "#e0af68" }
    }

    Row {
        flexGrow: 1

        ListView {
            id: nav
            width: 26
            focus: true
            model: root.pages
            backgroundColor: "#1f2335"
            selectedBackgroundColor: "#3d59a1"
            selectedTextColor: "#ffffff"
            textColor: "#a9b1d6"
            showDescription: true
        }

        Rectangle {
            flexGrow: 1
            color: "#1a1b26"
            border.width: 1
            border.color: "#414868"
            title: " " + root.pages[nav.currentIndex].name + " "
            padding: 1

            Text {
                text: root.pages[nav.currentIndex].body
                color: "#c0caf5"
            }
        }
    }

    Rectangle {
        height: 1
        color: "#3d59a1"
        flexDirection: "row"
        paddingLeft: 1
        Text { text: " ↑/↓ navigate · q quit"; color: "#ffffff" }
    }
}
