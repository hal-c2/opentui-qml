Plugin {
    id: managedPlugin
    order: 1
    Contribution {
        slot: "side"
        mode: "managed"
        TestText {
            property int created: { log.push("managed created"); return 1 }
            text: "managed " + slot + " " + data.n
        }
    }
}
