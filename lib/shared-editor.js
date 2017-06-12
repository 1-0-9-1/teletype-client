const SharedBuffer = require('./shared-buffer')
const {serializeRemotePosition, deserializeRemotePosition} = require('@atom-team/tachyon')
const FragmentInbox = require('./fragment-inbox')

module.exports =
class SharedEditor {
  constructor ({id, sharedBuffer, restGateway, pubSubGateway}) {
    this.id = id
    this.sharedBuffer = sharedBuffer
    this.restGateway = restGateway
    this.pubSubGateway = pubSubGateway
    this.nextMessageId = 1
    this.inbox = new FragmentInbox()
    this.selectionMarkerLayersBySiteId = {}
    this.lastSetSelectionRangePromise = Promise.resolve()
  }

  async create ({sharedBuffer, selectionRanges}) {
    this.sharedBuffer = sharedBuffer
    this.selectionMarkerLayersBySiteId = {
      1: selectionRanges
    }

    const {replica} = this.sharedBuffer
    const {id} = await this.restGateway.post(
      `/shared-editors`,
      {
        sharedBufferId: this.sharedBuffer.id,
        selectionRanges: this.serializeMarkerRanges(selectionRanges)
      }
    )
    this.id = id
    await this.subscribe()
  }

  async join () {
    const {sharedBufferId, selectionMarkerLayersBySiteId} = await this.restGateway.get(`/shared-editors/${this.id}`)
    this.sharedBuffer = new SharedBuffer({
      id: sharedBufferId,
      restGateway: this.restGateway,
      pubSubGateway: this.pubSubGateway
    })
    await this.sharedBuffer.join()
    await this.subscribe()
    for (const siteId in selectionMarkerLayersBySiteId) {
      this.selectionMarkerLayersBySiteId[siteId] = await this.deserializeMarkerRanges(selectionMarkerLayersBySiteId[siteId])
    }
  }

  async subscribe () {
    this.subscription = await this.pubSubGateway.subscribe(
      `/shared-editors/${this.id}`,
      'update',
      this.receiveUpdate.bind(this)
    )
  }

  setDelegate (delegate) {
    this.delegate = delegate
    for (let siteId in this.selectionMarkerLayersBySiteId) {
      siteId = Number(siteId)
      if (this.delegate && siteId !== this.sharedBuffer.siteId) {
        this.delegate.setSelectionMarkerLayerForSiteId(
          siteId,
          this.selectionMarkerLayersBySiteId[siteId]
        )
      }
    }
  }

  setSelectionRanges (selectionRanges) {
    this.selectionMarkerLayersBySiteId[this.sharedBuffer.siteId] = selectionRanges
    this.lastSetSelectionRangePromise = new Promise(async (resolve) => {
      await this.lastSetSelectionRangePromise
      await this.restGateway.put(
        `/shared-editors/${this.id}/selection-marker-layers/${this.sharedBuffer.siteId}`,
        {
          markerRanges: this.serializeMarkerRanges(selectionRanges),
          messageId: this.sharedBuffer.siteId + '.' + this.nextMessageId++
        }
      )
      resolve()
    })
    return this.lastSetSelectionRangePromise
  }

  async receiveUpdate (envelope) {
    let message = this.inbox.receive(envelope)
    if (message) {
      const {siteId, markerRanges: remoteMarkerRanges} = message
      const markerLayer = await this.deserializeMarkerRanges(remoteMarkerRanges)
      this.selectionMarkerLayersBySiteId[siteId] = markerLayer
      if (this.delegate && siteId !== this.sharedBuffer.siteId) {
        this.delegate.setSelectionMarkerLayerForSiteId(
          siteId,
          this.selectionMarkerLayersBySiteId[siteId]
        )
      }
    }
  }

  serializeMarkerRanges (localRanges) {
    const remoteMarkerRanges = {}
    for (const id in localRanges) {
      const {start, end} = localRanges[id]
      remoteMarkerRanges[id] = {
        start: this.serializeRemotePosition(start),
        end: this.serializeRemotePosition(end)
      }
    }
    return JSON.stringify(remoteMarkerRanges)
  }

  async deserializeMarkerRanges (serializedRemoteRanges) {
    const remoteRanges = JSON.parse(serializedRemoteRanges)
    const localRanges = {}
    for (const id in remoteRanges) {
      const {start, end} = remoteRanges[id]
      localRanges[id] = {
        start: await this.deserializeRemotePosition(start),
        end: await this.deserializeRemotePosition(end)
      }
    }
    return localRanges
  }

  serializeRemotePosition (remotePosition) {
    return new Buffer(serializeRemotePosition(
      this.sharedBuffer.replica.getRemotePosition(remotePosition)
    )).toString('base64')
  }

  deserializeRemotePosition (data) {
    return this.sharedBuffer.replica.getLocalPosition(
      deserializeRemotePosition(new Buffer(data, 'base64'))
    )
  }
}