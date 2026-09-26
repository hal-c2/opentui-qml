import OpenTUI

// A reusable component ("brick"): sibling .qml files in the same directory become types,
// so `import "components"` (or being next to the file) makes `Card { }` available.
// Children written inside `Card { ... }` are routed into the `inner` Column by the
// default property alias.
Rectangle {
    id: card
    property string heading: "Card"
    property color accent: "#7aa2f7"
    property alias body: inner
    default property alias content: inner.data

    border.width: 1
    border.color: accent
    radius: 1
    title: " " + heading + " "
    titleColor: accent
    padding: 1
    flexDirection: "column"

    Column { id: inner; flexGrow: 1 }
}
