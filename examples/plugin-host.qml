import OpenTUI

// A host application with two plugin mount points. Run it with the example plugins:
//
//   bun src/cli.ts examples/plugin-host.qml --plugins examples/plugins
//
// Without --plugins the Slots show their fallback children instead.
Window {
    id: root
    color: "#1a1b26"
    flexDirection: "column"

    property string user: "guest"
    property int presses: 0

    Keys.onPressed: (event) => {
        if (event.key === "q" || event.key === "escape") Qt.quit()
        else root.presses++
    }

    Row {
        flexGrow: 1

        // Every plugin contributing to "sidebar" is stacked here.
        Rectangle {
            width: 28
            color: "#16161e"
            border.width: 1
            border.color: "#414868"
            paddingLeft: 1

            Slot {
                name: "sidebar"
                flexGrow: 1
                spacing: 1
                data: ({ user: root.user, presses: root.presses })

                Text { text: "No sidebar plugins loaded."; color: "#565f89" }
            }
        }

        Column {
            flexGrow: 1
            paddingLeft: 2
            paddingTop: 1

            Text { text: "Plugin host"; color: "#7aa2f7"; font.bold: true }
            Text { text: "Keys pressed: " + root.presses; color: "#c0caf5" }
            Text { text: "Press q or Esc to quit"; color: "#565f89" }
        }
    }

    // A one-line status bar: the fallback is replaced by plugin contributions, laid out in a row.
    Rectangle {
        height: 1
        color: "#24283b"
        paddingLeft: 1

        Slot {
            name: "statusbar"
            flexGrow: 1
            flexDirection: "row"
            spacing: 3
            data: ({ user: root.user, presses: root.presses })

            Text { text: "ready"; color: "#565f89" }
        }
    }
}
