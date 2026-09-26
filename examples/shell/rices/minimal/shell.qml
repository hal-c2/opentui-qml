import OpenTUI
import Demo.Bricks

// A user shell: the same bricks, the sidebar on the right, no status bar, other colours.
ShellWindow {
    color: "#1e1e2e"
    main.flexDirection: "row-reverse"
    statusBar.visible: false
    sidebar.width: 18
    sidebar.color: "#181825"
    sidebar.highlight: "#f5c2e7"
    sidebar.heading: " Go to "

    Card {
        heading: Shell.pageTitle + " (minimal rice)"
        accent: "#f5c2e7"
        color: "#1e1e2e"
        flexGrow: 1
        Repeater {
            model: Shell.state.messages
            delegate: Text { text: "> " + modelData; color: "#cdd6f4" }
        }
        Text { text: "page: " + Shell.state.page + " · gen " + Runtime.generation; color: "#6c7086" }
    }
    Composer { placeholder: "Write here" }

    Shortcut { sequence: "q"; onActivated: Qt.quit() }
    Shortcut { sequence: "ctrl+r"; onActivated: Runtime.reload() }
    Shortcut { sequence: "ctrl+b"; onActivated: Shell.dispatch("toggleSidebar") }
    Shortcut { sequence: "ctrl+n"; onActivated: Shell.dispatch("navigate", "next") }
}
