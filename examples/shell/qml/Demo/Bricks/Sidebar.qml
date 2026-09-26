import OpenTUI

// The page list. Reads `Shell.state.pages` / `Shell.state.page`; never owns them.
Rectangle {
    id: bar
    property string heading: " Pages "
    property string highlight: Palette.accent

    width: 22
    color: Palette.surface
    border.width: 1
    border.color: Palette.border
    radius: Palette.radius
    title: heading
    titleColor: Palette.muted
    paddingX: 1
    flexDirection: "column"

    Repeater {
        model: Shell.state.pages
        delegate: Text {
            text: (Shell.state.page === modelData.id ? "▸ " : "  ") + modelData.title
            color: Shell.state.page === modelData.id ? bar.highlight : Palette.text
            font.bold: Shell.state.page === modelData.id
        }
    }
    Item { flexGrow: 1 }
    Text { text: "ctrl+n next page"; color: Palette.muted }
}
