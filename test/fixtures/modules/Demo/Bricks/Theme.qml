pragma Singleton
import OpenTUI

QtObject {
    property string accent: "#ff0000"
    property int spacing: 2
    Component.onCompleted: themeLog.push("Theme created")
}
