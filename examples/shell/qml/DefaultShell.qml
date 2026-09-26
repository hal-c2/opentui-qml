import OpenTUI
import Demo.Bricks

// The built-in arrangement. Drop a shell.qml into the config directory to replace it
// (see ../rices/ for two examples).
ShellWindow {
    toolbar: Component {
        Rectangle {
            height: 1
            color: Palette.surface
            paddingX: 1
            Text { text: Shell.pageTitle + " — " + Shell.state.page; color: Palette.accent; font.bold: true }
        }
    }

    Card {
        heading: "Messages"
        flexGrow: 1
        Repeater {
            model: Shell.state.messages
            delegate: Text { text: "• " + modelData; color: Palette.text }
        }
        Text {
            visible: Shell.state.messages.length === 0
            text: "No messages yet. Press / to write one."
            color: Palette.muted
        }
    }
    Composer { }
    Text { text: "q quit · ctrl+b sidebar · ctrl+n next page · ctrl+r reload"; color: Palette.muted }

    Shortcut { sequence: "q"; onActivated: Qt.quit() }
    Shortcut { sequence: "ctrl+r"; onActivated: Runtime.reload() }
    Shortcut { sequence: "ctrl+b"; onActivated: Shell.dispatch("toggleSidebar") }
    Shortcut { sequence: "ctrl+n"; onActivated: Shell.dispatch("navigate", "next") }
}
