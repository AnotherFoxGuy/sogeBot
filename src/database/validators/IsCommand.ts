import { registerDecorator, ValidationOptions } from 'class-validator';

export function IsCommand(validationOptions?: ValidationOptions) {
  return function (object: Record<string, unknown>, propertyName: string) {
    registerDecorator({
      name:         'isCommand',
      target:       object.constructor,
      propertyName: propertyName,
      options:      validationOptions,
      validator:    {
        validate(value: any) {
          return typeof value === 'string'
            && value.startsWith('!');
        },
      },
    });
  };
}