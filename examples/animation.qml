import OpenTUI

// NumberAnimation / SequentialAnimation / ParallelAnimation on plain properties.
Window {
    id: root
    color: "#1a1b26"

    property real progress: 0
    property real offset: 0

    Keys.onPressed: (event) => {
        if (event.key === "q" || event.key === "escape") Qt.quit()
        else if (event.key === "space") intro.restart()
        else if (event.key === "p") intro.paused = !intro.paused
    }

    SequentialAnimation {
        id: intro
        running: true
        loops: Animation.Infinite

        ParallelAnimation {
            NumberAnimation { target: root; property: "progress"; from: 0; to: 100; duration: 1500; easing.type: Easing.InOutQuad }
            NumberAnimation { target: root; property: "offset"; from: 0; to: 20; duration: 1500; easing.type: Easing.OutBounce }
        }
        PauseAnimation { duration: 500 }
        NumberAnimation { target: root; properties: "progress,offset"; to: 0; duration: 800; easing.type: Easing.InCubic }
    }

    Column {
        padding: 1
        gap: 1

        Text { text: "Animations"; color: "#7aa2f7"; font.bold: true }

        Text {
            color: "#9ece6a"
            text: "[" + "#".repeat(Math.round(root.progress / 5)) + " ".repeat(20 - Math.round(root.progress / 5)) + "] " + Math.round(root.progress) + "%"
        }

        Item {
            height: 1
            Text { left: Math.round(root.offset); position: "absolute"; text: "●"; color: "#e0af68" }
        }

        Text { text: (intro.paused ? "paused" : "running") + " · space restart · p pause · q quit"; color: "#565f89" }
    }
}
