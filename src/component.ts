import Vue, { ComponentOptions } from 'vue'
import { copyReflectionMetadata, reflectionIsSupported } from './reflect'
import { VueClass, DecoratedClass } from './declarations'
import { collectDataFromConstructor } from './data'
import { hasProto, isPrimitive, warn } from './util'

export const $internalHooks = [
  'data',
  'beforeCreate',
  'created',
  'beforeMount',
  'mounted',
  'beforeDestroy',
  'destroyed',
  'beforeUpdate',
  'updated',
  'activated',
  'deactivated',
  'render',
  'errorCaptured', // 2.5
  'serverPrefetch' // 2.6
]

// BIFIT: Список хуков, для которых будет работать правильно наследование. Поддержка остальных может потребовать лезть в кишки Vue
const $keepHooks = [
  'beforeCreate',
  'created',
  'beforeMount',
  'mounted',
  'beforeDestroy',
  'destroyed',
  'beforeUpdate',
  'updated',
  'activated',
  'deactivated'
]

export function componentFactory (
  Component: VueClass<Vue>,
  options: ComponentOptions<Vue> = {}
): VueClass<Vue> {
  options.name = options.name || (Component as any)._componentTag || (Component as any).name
  const proto = Component.prototype
  // BIFIT: ---------- start
  const protoMethods: string[] = [];
  const protoGetAndSets: string[] = [];
  const protoHooks: Array<{key: string, descriptor: PropertyDescriptor}> = [];
  const protoMarker = Symbol();
  // BIFIT: ---------- end
  Object.getOwnPropertyNames(proto).forEach(function (key) {
    if (key === 'constructor') {
      return
    }

    const descriptor = Object.getOwnPropertyDescriptor(proto, key)!
    // hooks
    if ($internalHooks.indexOf(key) > -1) {
      if ($keepHooks.indexOf(key) > -1 && descriptor.value !== void 0 && typeof descriptor.value === 'function') {
        // Этот метод используется как метод, а не хук
        proto[key] = function () {
          descriptor.value.call(this);
        }
        // BIFIT: Этот метод будет вызывать Vue для хуков жизненного цикла
        const methodHiddenAccess = Symbol();
        proto[methodHiddenAccess] = function () {
          // BIFIT: Vue вызывает хуки один за одним у всех наследников
          // BIFIT: Только, если совпадает владелец функции и место декларации функции
          if (this.$marker === protoMarker) {
            descriptor.value.call(this);
          }
          // BIFIT: Только, если это декларация хука на самом верху цепочки наследования
          else if (this.__proto__ && !this.__proto__.hasOwnProperty(key)) {
            let startProto = this.__proto__;
            while (startProto && !startProto.hasOwnProperty(key)) {
              startProto = startProto.__proto__;
            }
            if (startProto && startProto.$marker === protoMarker) {
              descriptor.value.call(this);
            }
          }
        }
        protoHooks.push({key, descriptor: Object.getOwnPropertyDescriptor(proto, key)!});
        options[key] = proto[methodHiddenAccess];
      } else {
        options[key] = proto[key]
      }
      return
    }
    if (descriptor.value !== void 0) {
      // methods
      if (typeof descriptor.value === 'function') {
        (options.methods || (options.methods = {}))[key] = descriptor.value
        protoMethods.push(key);
      } else {
        // typescript decorated data
        (options.mixins || (options.mixins = [])).push({
          data (this: Vue) {
            return { [key]: descriptor.value }
          }
        })
      }
    } else if (descriptor.get || descriptor.set) {
      // computed properties
      (options.computed || (options.computed = {}))[key] = {
        get: descriptor.get,
        set: descriptor.set
      }
      protoGetAndSets.push(key);
    }
  })

  // add data hook to collect class properties as Vue instance's data
  ;(options.mixins || (options.mixins = [])).push({
    data (this: Vue) {
      return collectDataFromConstructor(this, Component)
    }
  })

  // decorate options
  const decorators = (Component as DecoratedClass).__decorators__
  if (decorators) {
    decorators.forEach(fn => fn(options))
    delete (Component as DecoratedClass).__decorators__
  }

  // find super
  const superProto = Object.getPrototypeOf(Component.prototype)
  const Super = superProto instanceof Vue
    ? superProto.constructor as VueClass<Vue>
    : Vue


  const Extended = Super.extend(options)

  forwardStaticMembers(Extended, Component, Super)

  if (reflectionIsSupported()) {
    copyReflectionMetadata(Extended, Component)
  }

  // BIFIT: ---------- start
  // const printMethods = (data: any, name: string): void => {
  //   console.log(">> print for: ", name);
  //   Object.getOwnPropertyNames(data).forEach(function (key) {
  //     const descriptor = Object.getOwnPropertyDescriptor(data, key)!
  //     if (descriptor && descriptor.value !== void 0) {
  //       console.log("  --- ", key);
  //     }
  //   });
  // }
  (<any> Extended).prototype.$marker = protoMarker

  // const compName = (<any> Extended).prototype.constructor && (<any> Extended).prototype.constructor.name || protoSymbol;
  // console.log("Обработка компонента " + compName);
  protoMethods.forEach(key => {
    installMethods(Extended, key);
    // console.log("    Сохраняем метод " + data.key);
  })
  protoGetAndSets.forEach(key => {
    installGetAndSets(Extended, key)
    // console.log("    Сохраняем  get/set " + key);
  })
  protoHooks.forEach(data => {
    installHooks(Extended, data.key, data.descriptor)
    // console.log("    Сохраняем хук " + data.key);
  })
  // BIFIT: ---------- end
  return Extended
}

const reservedPropertyNames = [
  // Unique id
  'cid',

  // Super Vue constructor
  'super',

  // Component options that will be used by the component
  'options',
  'superOptions',
  'extendOptions',
  'sealedOptions',

  // Private assets
  'component',
  'directive',
  'filter'
]

const shouldIgnore = {
  prototype: true,
  arguments: true,
  callee: true,
  caller: true
}

function forwardStaticMembers (
  Extended: typeof Vue,
  Original: typeof Vue,
  Super: typeof Vue
): void {
  // We have to use getOwnPropertyNames since Babel registers methods as non-enumerable
  Object.getOwnPropertyNames(Original).forEach(key => {
    // Skip the properties that should not be overwritten
    if (shouldIgnore[key]) {
      return
    }

    // Some browsers does not allow reconfigure built-in properties
    const extendedDescriptor = Object.getOwnPropertyDescriptor(Extended, key)
    if (extendedDescriptor && !extendedDescriptor.configurable) {
      return
    }

    const descriptor = Object.getOwnPropertyDescriptor(Original, key)!

    // If the user agent does not support `__proto__` or its family (IE <= 10),
    // the sub class properties may be inherited properties from the super class in TypeScript.
    // We need to exclude such properties to prevent to overwrite
    // the component options object which stored on the extended constructor (See #192).
    // If the value is a referenced value (object or function),
    // we can check equality of them and exclude it if they have the same reference.
    // If it is a primitive value, it will be forwarded for safety.
    if (!hasProto) {
      // Only `cid` is explicitly exluded from property forwarding
      // because we cannot detect whether it is a inherited property or not
      // on the no `__proto__` environment even though the property is reserved.
      if (key === 'cid') {
        return
      }

      const superDescriptor = Object.getOwnPropertyDescriptor(Super, key)

      if (
        !isPrimitive(descriptor.value) &&
        superDescriptor &&
        superDescriptor.value === descriptor.value
      ) {
        return
      }
    }

    // Warn if the users manually declare reserved properties
    if (
      process.env.NODE_ENV !== 'production' &&
      reservedPropertyNames.indexOf(key) >= 0
    ) {
      warn(
        `Static property name '${key}' declared on class '${Original.name}' ` +
        'conflicts with reserved property name of Vue internal. ' +
        'It may cause unexpected behavior of the component. Consider renaming the property.'
      )
    }

    Object.defineProperty(Extended, key, descriptor)
  })
}

// BIFIT: ---------- start

/**
 * BIFIT: Сохранение методов в прототипе объекта. Они теряются после декларации const Extended = Super.extend(options)
 * @param target целевой объект - Extended
 * @param propertyKey наименование метода
 */
function installMethods(target: any, propertyKey: string): void {
  const scope = target.prototype || target.__proto__;
  if (scope &&
      scope.constructor &&
      scope.constructor.extendOptions &&
      scope.constructor.extendOptions.methods &&
      scope.constructor.extendOptions.methods[propertyKey] && !scope.hasOwnProperty(propertyKey)) {
      scope[propertyKey] = scope.constructor.extendOptions.methods[propertyKey];
  } else if (scope &&
      scope.constructor &&
      scope.constructor.superOptions &&
      scope.constructor.superOptions.methods &&
      scope.constructor.superOptions.methods[propertyKey] && !scope.hasOwnProperty(propertyKey)) {
      scope[propertyKey] = scope.constructor.superOptions.methods[propertyKey];
  }
}

/**
 * BIFIT: Сохранение get/set в прототипе объекта. Они теряют связь с наследником после декларации const Extended = Super.extend(options)
 * @param target целевой объект - Extended
 * @param propertyKey наименование get/set
 */
function installGetAndSets(target: any, propertyKey: string): void {
  const scope = target.prototype || target.__proto__;
  if (scope &&
      scope.constructor &&
      scope.constructor.extendOptions &&
      scope.constructor.extendOptions.computed &&
      scope.constructor.extendOptions.computed[propertyKey]/* && !scope.hasOwnProperty(propertyKey) */) {
      Object.defineProperty(scope, propertyKey, scope.constructor.extendOptions.computed[propertyKey])
  } else if (scope &&
      scope.constructor &&
      scope.constructor.superOptions &&
      scope.constructor.superOptions.computed &&
      scope.constructor.superOptions.computed[propertyKey]/* && !scope.hasOwnProperty(propertyKey)*/) {
      Object.defineProperty(scope, propertyKey, scope.constructor.superOptions.computed[propertyKey])
  }
}

/**
 * BIFIT: Сохранение хуков в прототипе объекта. Они теряются после декларации const Extended = Super.extend(options)
 * Список хуков для сохранения следующий `$keepHooks`:
    -  'beforeCreate',
    -  'created',
    -  'beforeMount',
    -  'mounted',
    -  'beforeDestroy',
    -  'destroyed',
    -  'beforeUpdate',
    -  'updated',
    -  'activated',
    -  'deactivated'
 * @param target целевой объект - Extended
 * @param propertyKey наименование хука
 * @param descriptor
 */
function installHooks(target: any, propertyKey: string, descriptor: PropertyDescriptor): void {
  const scope = target.prototype || target.__proto__;
  if (scope && !scope.hasOwnProperty(propertyKey)) {
    scope[propertyKey] = descriptor.value;
  }
}

// BIFIT: ---------- end