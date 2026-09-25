import OpenTUI

// Contributes a live clock to the host's "statusbar" slot.
Plugin {
    id: clock                     // the plugin id defaults to the QML id ("clock")
    order: 100                    // after other status bar items

    property string now: new Date().toLocaleTimeString()

    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: clock.now = new Date().toLocaleTimeString()
    }

    Contribution {
        slot: "statusbar"
        Text { text: "⏱ " + clock.now; color: "#9ece6a" }
    }
}
