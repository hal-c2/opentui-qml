import OpenTUI
import "components"

Window {
    color: "#1a1b26"
    flexDirection: "row"
    padding: 1
    gap: 2

    Keys.onPressed: (event) => { if (event.key === "q" || event.key === "escape") Qt.quit() }

    Card {
        heading: "Left"
        accent: "#9ece6a"
        width: 30
        Text { text: "Content of the left card"; color: "#c0caf5" }
    }

    Card {
        heading: "Right"
        accent: "#f7768e"
        flexGrow: 1
        Text { text: "Cards are defined once in components/Card.qml"; color: "#c0caf5" }
        Text { text: "and reused with different properties."; color: "#565f89" }
    }
}
