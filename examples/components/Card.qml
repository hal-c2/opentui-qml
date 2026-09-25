import OpenTUI

// A reusable component: sibling .qml files in the same directory become types,
// so `import "components"` (or being next to the file) makes `Card { }` available.
Rectangle {
    id: card
    property string heading: "Card"
    property color accent: "#7aa2f7"

    border.width: 1
    border.color: accent
    radius: 1
    title: " " + heading + " "
    titleColor: accent
    padding: 1
    flexDirection: "column"
}
