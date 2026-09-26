import OpenTUI

// The frame: an optional toolbar, a row with the sidebar and the content area, a status bar.
//
//   ShellWindow {
//       main.flexDirection: "row-reverse"      // sidebar on the right
//       sidebar.width: 30                      // tweak one piece
//       statusBar.visible: false
//       toolbar: Component { Text { text: "..." } }
//       Card { ... }                           // content goes into the body
//   }
Window {
    id: win
    default property alias content: body.data
    property alias main: mainRow
    property alias sidebar: sidebarView
    property alias body: body
    property alias statusBar: statusBarView
    property alias toolbar: toolbarLoader.sourceComponent

    color: Palette.chrome
    flexDirection: "column"

    Loader { id: toolbarLoader }

    Item {
        id: mainRow
        flexDirection: "row"
        flexGrow: 1
        Sidebar { id: sidebarView; visible: !Shell.state.sidebarCollapsed }
        Column { id: body; flexGrow: 1; paddingX: 1; spacing: 0 }
    }

    StatusBar { id: statusBarView }
}
