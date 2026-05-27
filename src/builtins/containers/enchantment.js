const { putSlot } = require('./helpers')

function cloneEnchantList (enchants) {
  return (enchants ?? []).map(enchant => ({
    id: enchant.id,
    level: enchant.level
  }))
}

function normalizeEnchantOption (option, index) {
  return {
    index,
    cost: option.cost ?? 0,
    slotFlags: option.slot_flags,
    recipeNetworkId: option.option_id,
    equipEnchants: cloneEnchantList(option.equip_enchants),
    heldEnchants: cloneEnchantList(option.held_enchants),
    selfEnchants: cloneEnchantList(option.self_enchants),
    name: option.name ?? '',
    optionId: option.option_id,
    raw: option
  }
}

function apply (container) {
  container.putInput = putSlot(container, 0)
  container.putLapis = putSlot(container, 1)
  container.enchantOptions = []
  container.lastEnchantOptionsPacket = null

  container.handlePlayerEnchantOptions = function handlePlayerEnchantOptions (packet) {
    container.lastEnchantOptionsPacket = packet
    container.enchantOptions = (packet.options ?? []).map(normalizeEnchantOption)

    container.botState?.emit('enchant_options_updated', {
      container,
      options: container.getEnchantOptions(),
      packet
    })

    return true
  }

  container.getEnchantOptions = function getEnchantOptions () {
    return container.enchantOptions.map(option => ({
      ...option,
      equipEnchants: cloneEnchantList(option.equipEnchants),
      heldEnchants: cloneEnchantList(option.heldEnchants),
      selfEnchants: cloneEnchantList(option.selfEnchants)
    }))
  }

  container.getEnchantOption = function getEnchantOption (index) {
    return container.getEnchantOptions()[index] ?? null
  }

  container.findEnchantOption = function findEnchantOption (predicate) {
    return container.getEnchantOptions().find(predicate) ?? null
  }

  container.waitForEnchantOptions = function waitForEnchantOptions (predicate = options => options.length > 0, timeoutMs = 10000) {
    const current = container.getEnchantOptions()
    if (predicate(current)) return Promise.resolve(current)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for enchant options'))
      }, timeoutMs)

      function onOptions ({ container: updatedContainer, options }) {
        if (updatedContainer !== container || !predicate(options)) return
        cleanup()
        resolve(options)
      }

      function cleanup () {
        clearTimeout(timeout)
        container.botState?.off('enchant_options_updated', onOptions)
      }

      container.botState?.on('enchant_options_updated', onOptions)
    })
  }

  container.selectEnchantOption = async function selectEnchantOption (optionOrIndex) {
    const option = Number.isInteger(optionOrIndex)
      ? container.getEnchantOption(optionOrIndex)
      : optionOrIndex

    if (!option) throw new Error(`No enchant option found for ${optionOrIndex}`)
    if (!Number.isInteger(option.recipeNetworkId)) {
      throw new Error(`Enchant option is missing recipeNetworkId: ${JSON.stringify(option)}`)
    }

    const helpers = container.botState?.inventory?.actions ?? container.botState?.inventoryActionHelpers
    if (!helpers) throw new Error('inventory-actions builtin is required before selecting enchant options')

    const request = helpers.makeRequest([{
      type_id: 'craft_recipe',
      recipe_network_id: option.recipeNetworkId,
      times_crafted: 1
    }])
    const id = helpers.send(request)
    return helpers.wait(id)
  }

  return container
}

module.exports = {
  matches: container => container.type === 'enchantment',
  apply
}
