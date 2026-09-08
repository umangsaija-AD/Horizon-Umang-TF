export const CART_PROPERTY_KEYS = Object.freeze({
  addToCartId: '_add_to_cart_id',
  itemType: '_item_type',
  giftMessageData: 'gift_message',
  greetingCardData: 'greeting_card',
  digitalCardData: '_digital_card',
  isOnGoody: '_is_on_goody',
  isBundleAddon: '_is_bundle_addon',
  lineItemOrder: '_line_item_order',
  cyoGroupKey: '_cyo_group_key',
  cyoRole: '_cyo_role',
  cyoBoxType: '_cyo_box_type',
  cyoSummary: '_cyo_summary',
  cyoItemCount: '_cyo_item_count',
  cyoParentProductId: '_cyo_parent_product_id',
});

export const CART_ITEM_TYPES = Object.freeze({
  parent: 'parent',
  addOn: 'add_on',
  upgrade: 'upgrade',
  greetingCard: 'greeting_card',
  bundleLineItem: 'bundle_line_item',
  giftMessage: 'gift_message',
  digitalCard: 'digital_card',
});

export const CYO_ROLES = Object.freeze({
  parent: 'parent',
  child: 'child',
});

export const DIGITAL_CARD_DELIVERY_METHODS = Object.freeze({
  text: '1',
  email: '2',
});
