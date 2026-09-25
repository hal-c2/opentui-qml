import OpenTUI

// Contributes a greeting to the sidebar and a key counter to the status bar.
// `data` is the Slot's `data` object and updates when the host changes it.
Plugin {
    pluginId: "hello"
    order: 10
    description: "Greets the user"

    Component.onCompleted: console.log("hello plugin loaded")
    Component.onDestruction: console.log("hello plugin unloaded")

    Contribution {
        slot: "sidebar"
        Column {
            Text { text: "Hello, " + data.user + "!"; color: "#bb9af7"; font.bold: true }
            Text { text: "(from plugins/hello.qml)"; color: "#565f89" }
        }
    }

    Contribution {
        slot: "statusbar"
        Text { text: "keys: " + data.presses; color: "#e0af68" }
    }
}
