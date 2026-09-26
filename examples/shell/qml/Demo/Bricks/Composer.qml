import OpenTUI

// A one-line input: Enter sends `Shell.dispatch("compose", text)`. `/` focuses it, Esc leaves.
Rectangle {
    id: composer
    property alias placeholder: input.placeholderText

    height: 3
    border.width: 1
    border.color: input.focused ? Palette.accent : Palette.border
    radius: Palette.radius
    color: Palette.chrome
    title: input.focused ? " Message (Esc to leave) " : " Message (/ to write) "
    titleColor: Palette.muted

    TextInput {
        id: input
        flexGrow: 1
        placeholderText: "Say something and press Enter"
        color: Palette.text
        focusedColor: Palette.text
        backgroundColor: Palette.chrome
        focusedBackgroundColor: Palette.chrome
        onAccepted: {
            Shell.dispatch("compose", text)
            text = ""
        }
    }

    Shortcut { sequence: "/"; enabled: !input.focused; onActivated: input.forceActiveFocus() }
    Shortcut { sequence: "escape"; enabled: input.focused; onActivated: input.focus = false }
}
