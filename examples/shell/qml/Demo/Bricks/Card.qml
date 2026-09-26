import OpenTUI

// A titled, bordered container: children go inside.
Rectangle {
    id: card
    property string heading: ""
    property string accent: Palette.accent
    default property alias content: inner.data

    border.width: 1
    border.color: Palette.border
    radius: Palette.radius
    color: Palette.chrome
    title: heading !== "" ? " " + heading + " " : ""
    titleColor: accent
    paddingX: 1
    flexDirection: "column"

    Column { id: inner; flexGrow: 1 }
}
