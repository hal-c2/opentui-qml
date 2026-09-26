import OpenTUI

// One line: the app's clock on the left, which shell is live on the right.
Rectangle {
    height: 1
    color: Palette.surface
    flexDirection: "row"
    paddingX: 1

    Text { text: Shell.state.clock; color: Palette.accent }
    Item { flexGrow: 1 }
    Text {
        text: (Runtime.usingUserShell ? "user shell" : "default shell") + " · gen " + Runtime.generation
        color: Palette.muted
    }
}
