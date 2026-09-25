Item {
    id: root
    width: 40
    height: 6
    property int words: 3
    Slot {
        id: status
        objectName: "status"
        name: "status"
        height: 3
        data: ({ words: root.words })
        TestText { text: "no plugins" }
    }
}
